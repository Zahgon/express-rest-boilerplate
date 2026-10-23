const url = require('url');
const zlib = require('zlib');
const getRawBody = require('raw-body');
const iconv = require('iconv-lite');
const contentType = require('content-type');
const qs = require('qs');
const etag = require('etag');
const fresh = require('fresh');
const vary = require('vary');
const compressible = require('compressible');

/**
 * The parts of the HTTP contract that the express stack produced on its own,
 * before and around the routes: body parsing, security and CORS headers, entity
 * tags with conditional GET, and the header names and order on the wire.
 * Fastify does each of these differently by default, so they are reproduced
 * here on the raw node request and response.
 */

const BODY_LIMIT = 100 * 1024;
const PARAMETER_LIMIT = 1000;
const kCompressible = Symbol('compressible');
const kFrontend = Symbol('frontend headers');
const kMethod = Symbol('request method');
const COMPRESSION_THRESHOLD = 1024;
const NO_TRANSFORM = /(?:^|,)\s*?no-transform\s*?(?:,|$)/;
// a doubled slash right behind a mount point was swallowed by the express router
const MOUNT_SLASHES = [/^(\/v1)\/(?=\/)/i, /^(\/v1\/(?:users|auth|docs))\/(?=\/)/i];
// the methods fastify 4 can route; node accepts more of them (QUERY, ACL, ...)
const ROUTABLE_METHODS = new Set(['DELETE', 'GET', 'HEAD', 'PATCH', 'POST', 'PUT', 'OPTIONS', 'PROPFIND',
  'PROPPATCH', 'MKCOL', 'COPY', 'MOVE', 'LOCK', 'UNLOCK', 'TRACE', 'SEARCH', 'REPORT', 'MKCALENDAR']);

const httpError = (status, message) => Object.assign(new Error(message), { status });

/**
 * express' extended query string parser
 * @public
 */
exports.parseQuery = (str) => qs.parse(str, { allowPrototypes: true });

/**
 * The request target the express router matched against: the path of an
 * absolute-form target whatever its scheme, a doubled slash behind a mount point
 * dropped, and percent escapes kept, so that only route parameters get decoded
 * @public
 */
exports.routingUrl = (target) => {
  let routed = target;
  if (routed[0] !== '/' && routed !== '*') {
    // the legacy parser is the one express read the path with (through parseurl)
    const parsed = url.parse(routed);
    if (parsed.pathname) routed = parsed.pathname + (parsed.search || '');
  }
  const queryAt = routed.indexOf('?');
  let path = queryAt === -1 ? routed : routed.slice(0, queryAt);
  const search = queryAt === -1 ? '' : routed.slice(queryAt);
  MOUNT_SLASHES.forEach((mount) => { path = path.replace(mount, '$1'); });
  return path.replace(/%/g, '%25') + search;
};

const CLIENT_ERROR_STATUS = {
  HPE_HEADER_OVERFLOW: '431 Request Header Fields Too Large',
  HPE_CHUNK_EXTENSIONS_OVERFLOW: '413 Payload Too Large',
  ERR_HTTP_REQUEST_TIMEOUT: '408 Request Timeout',
};

/**
 * Answers a request the HTTP parser rejected with node's own bare response
 * @public
 */
exports.clientError = (err, socket) => {
  if (socket.writable && socket.bytesWritten === 0) {
    const status = CLIENT_ERROR_STATUS[err.code] || '400 Bad Request';
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  }
  socket.destroy(err);
};

/**
 * Decodes the matched route parameters the way the express router did
 * @public
 */
exports.decodeParams = (params) => {
  Object.keys(params || {}).forEach((name) => {
    const value = params[name];
    if (typeof value !== 'string' || value.length === 0) return;
    try {
      // eslint-disable-next-line no-param-reassign -- decoded in place, as express did
      params[name] = decodeURIComponent(value);
    } catch (err) {
      if (err instanceof URIError) {
        err.message = `Failed to decode param '${value}'`;
        err.status = 400;
        err.statusCode = 400;
      }
      throw err;
    }
  });
};

/**
 * A method fastify cannot route reaches the not-found handler under a routable
 * method that has no routes, like it reached the 404 handler in express
 * @public
 */
exports.routableMethod = (req) => {
  if (ROUTABLE_METHODS.has(req.method)) return;
  req[kMethod] = req.method;
  req.method = 'SEARCH'; // eslint-disable-line no-param-reassign -- routed under a method fastify knows
};

/**
 * Puts the method of the request back once it has been routed
 * @public
 */
exports.restoreMethod = (req) => {
  // eslint-disable-next-line no-param-reassign -- the method the client sent
  if (req[kMethod]) req.method = req[kMethod];
};

const hasBody = (req) => req.headers['transfer-encoding'] !== undefined
  || !Number.isNaN(Number(req.headers['content-length']));

const mediaType = (req) => {
  try {
    return contentType.parse(req.headers['content-type']).type;
  } catch (err) {
    return undefined;
  }
};

const charsetOf = (req) => {
  try {
    return (contentType.parse(req).parameters.charset || '').toLowerCase();
  } catch (err) {
    return undefined;
  }
};

const firstChar = (str) => {
  const match = /^[ \t\n\r]*(.)/.exec(str);
  return match ? match[1] : undefined;
};

// a strict-mode violation reports the JSON.parse error of the text up to the
// offending character, with that character put back into the message
const strictSyntaxError = (str, char) => {
  const index = str.indexOf(char);
  const partial = `${str.substring(0, index)}#`;
  try {
    JSON.parse(partial);
    return new SyntaxError('strict violation');
  } catch (err) {
    err.message = err.message.replace('#', char);
    return err;
  }
};

const parseJson = (body) => {
  if (body.length === 0) return {};
  const first = firstChar(body);
  if (first !== '{' && first !== '[') throw strictSyntaxError(body, first);
  return JSON.parse(body);
};

const parameterCount = (body, limit) => {
  let count = 0;
  let index = 0;
  while ((index = body.indexOf('&', index)) !== -1) { // eslint-disable-line no-cond-assign
    count += 1;
    index += 1;
    if (count === limit) return undefined;
  }
  return count;
};

const parseUrlencoded = (body) => {
  if (!body.length) return {};
  const count = parameterCount(body, PARAMETER_LIMIT);
  if (count === undefined) throw httpError(413, 'too many parameters');
  return qs.parse(body, {
    allowPrototypes: true,
    arrayLimit: Math.max(100, count),
    depth: Infinity,
    parameterLimit: PARAMETER_LIMIT,
  });
};

const contentStream = (req) => {
  const encoding = (req.headers['content-encoding'] || 'identity').toLowerCase();
  switch (encoding) {
    case 'deflate':
      return { stream: req.pipe(zlib.createInflate()) };
    case 'gzip':
      return { stream: req.pipe(zlib.createGunzip()) };
    case 'identity':
      return { stream: req, length: req.headers['content-length'] };
    default:
      throw httpError(415, `unsupported content encoding "${encoding}"`);
  }
};

const afterRequest = (req, callback) => {
  if (req.complete) {
    setImmediate(callback);
    return;
  }
  req.once('end', callback);
  req.once('close', callback);
};

const readBody = (req, charset, parse, next) => {
  let source;
  try {
    source = contentStream(req);
  } catch (err) {
    next(err);
    return;
  }
  if (!iconv.encodingExists(charset)) {
    next(httpError(415, `unsupported charset "${charset.toUpperCase()}"`));
    return;
  }
  const options = { encoding: charset, limit: BODY_LIMIT, length: source.length };
  getRawBody(source.stream, options, (error, body) => {
    if (error) {
      const failure = error.type === 'encoding.unsupported'
        ? httpError(415, `unsupported charset "${charset.toUpperCase()}"`)
        : Object.assign(error, { status: error.status || error.statusCode || 400 });
      source.stream.resume();
      let reported = false;
      afterRequest(req, () => {
        if (reported) return;
        reported = true;
        next(failure);
      });
      return;
    }
    try {
      req.body = parse(body);
    } catch (err) {
      next(Object.assign(err, { status: err.status || 400 }));
      return;
    }
    next();
  });
};

/**
 * Parses json and urlencoded bodies of any request method, the way the
 * body-parser middlewares did, leaving an empty object when there is nothing
 * to parse. Calls next(err) with a status for bodies that cannot be read.
 * @public
 */
exports.parseBody = (req, res, next) => {
  req.body = req.body || {};
  if (!hasBody(req)) {
    next();
    return;
  }
  const type = mediaType(req);
  if (type === 'application/json') {
    const charset = charsetOf(req) || 'utf-8';
    if (charset.substr(0, 4) !== 'utf-') {
      next(httpError(415, `unsupported charset "${charset.toUpperCase()}"`));
      return;
    }
    readBody(req, charset, parseJson, next);
    return;
  }
  if (type === 'application/x-www-form-urlencoded') {
    const charset = charsetOf(req) || 'utf-8';
    if (charset !== 'utf-8') {
      next(httpError(415, `unsupported charset "${charset.toUpperCase()}"`));
      return;
    }
    readBody(req, charset, parseUrlencoded, next);
    return;
  }
  next();
};

const SECURITY_HEADERS = [
  ['Content-Security-Policy', "default-src 'self';base-uri 'self';block-all-mixed-content;font-src 'self' https: data:;frame-ancestors 'self';img-src 'self' data:;object-src 'none';script-src 'self';script-src-attr 'none';style-src 'self' https: 'unsafe-inline';upgrade-insecure-requests"],
  ['X-DNS-Prefetch-Control', 'off'],
  ['Expect-CT', 'max-age=0'],
  ['X-Frame-Options', 'SAMEORIGIN'],
  ['Strict-Transport-Security', 'max-age=15552000; includeSubDomains'],
  ['X-Download-Options', 'noopen'],
  ['X-Content-Type-Options', 'nosniff'],
  ['X-Permitted-Cross-Domain-Policies', 'none'],
  ['Referrer-Policy', 'no-referrer'],
  ['X-XSS-Protection', '0'],
];

/**
 * Security headers, as helmet 4 set them by default
 * @public
 */
exports.securityHeaders = (req, res) => {
  SECURITY_HEADERS.forEach(([name, value]) => res.setHeader(name, value));
  res.removeHeader('X-Powered-By');
};

/**
 * CORS for any origin. Every OPTIONS request is answered here, preflight or not.
 * @returns {boolean} true when the response has been sent
 * @public
 */
exports.cors = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'OPTIONS') return false;
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE');
  const requested = req.headers['access-control-request-headers'];
  vary(res, 'Access-Control-Request-Headers');
  if (requested) res.setHeader('Access-Control-Allow-Headers', requested);
  res.statusCode = 204;
  res.setHeader('Content-Length', '0');
  res.end();
  return true;
};

/**
 * Responses from here on get "Vary: Accept-Encoding" when their type is compressible
 * @public
 */
exports.markCompressible = (res) => {
  res[kCompressible] = true;
};

/**
 * Whether a GET or HEAD response is still fresh for the client's cache validators
 * @public
 */
exports.isFresh = (method, status, requestHeaders, responseEtag) => {
  if (method !== 'GET' && method !== 'HEAD') return false;
  if ((status >= 200 && status < 300) || status === 304) {
    return fresh(requestHeaders, { etag: responseEtag });
  }
  return false;
};

const ENCODING_SPEC = /^\s*([^\s;]+)\s*(?:;(.*))?$/;

// how well one Accept-Encoding entry matches an encoding: exact beats '*'
const encodingMatch = (encoding, spec, index) => {
  if (spec.encoding.toLowerCase() === encoding.toLowerCase()) {
    return {
      index, order: spec.order, q: spec.q, specificity: 1,
    };
  }
  if (spec.encoding !== '*') return null;
  return {
    index, order: spec.order, q: spec.q, specificity: 0,
  };
};

// the Accept-Encoding entries, identity added at the lowest quality unless named
const parseAcceptEncoding = (header) => {
  const specs = [];
  let hasIdentity = false;
  let minQuality = 1;
  const entries = (header || '').split(',');
  entries.forEach((entry, order) => {
    const match = ENCODING_SPEC.exec(entry.trim());
    if (!match) return;
    let q = 1;
    if (match[2]) {
      const quality = match[2].split(';')
        .map((param) => param.trim().split('='))
        .find(([name]) => name === 'q');
      if (quality) q = parseFloat(quality[1]);
    }
    const spec = { encoding: match[1], q, order };
    specs.push(spec);
    hasIdentity = hasIdentity || encodingMatch('identity', spec) !== null;
    minQuality = Math.min(minQuality, q || 1);
  });
  if (!hasIdentity) specs.push({ encoding: 'identity', q: minQuality, order: entries.length });
  return specs;
};

/**
 * The client's preferred encoding among the available ones, negotiated the way
 * the compression middleware's negotiator did it, or false when none is acceptable
 * @private
 */
const preferredEncoding = (header, available) => {
  const specs = parseAcceptEncoding(header);
  const priorities = available.map((encoding, index) => specs.reduce((best, spec) => {
    const match = encodingMatch(encoding, spec, index);
    if (!match) return best;
    const better = best.specificity - match.specificity
      || best.q - match.q
      || best.order - match.order;
    return better < 0 ? match : best;
  }, {
    index, order: -1, q: 0, specificity: 0,
  }));
  const ranked = priorities.filter((priority) => priority.q > 0)
    .sort((a, b) => (b.q - a.q) || (b.specificity - a.specificity)
      || (a.order - b.order) || (a.index - b.index));
  return ranked.length ? available[ranked[0].index] : false;
};

/**
 * Compresses a response body the way the compression middleware did: a
 * compressible type of at least 1 kB, not for HEAD, gzip preferred over deflate
 * whenever the client accepts it
 * @public
 */
exports.compress = (req, reply, payload, done) => {
  if (!reply.raw[kCompressible] || (typeof payload !== 'string' && !Buffer.isBuffer(payload))) {
    done(null, payload);
    return;
  }
  const type = reply.getHeader('content-type');
  const cacheControl = reply.getHeader('cache-control');
  if (type === undefined || !compressible(String(type))
    || (cacheControl && NO_TRANSFORM.test(cacheControl))
    || Buffer.byteLength(payload) < COMPRESSION_THRESHOLD
    || (reply.getHeader('content-encoding') || 'identity') !== 'identity'
    || req.method === 'HEAD') {
    done(null, payload);
    return;
  }
  const accept = req.headers['accept-encoding'];
  let method = preferredEncoding(accept, ['gzip', 'deflate', 'identity']);
  if (method === 'deflate' && preferredEncoding(accept, ['gzip'])) {
    method = preferredEncoding(accept, ['gzip', 'identity']);
  }
  if (!method || method === 'identity') {
    done(null, payload);
    return;
  }
  const stream = method === 'gzip' ? zlib.createGzip() : zlib.createDeflate();
  reply.header('content-encoding', method);
  reply.removeHeader('content-length');
  stream.end(payload);
  done(null, stream);
};

/**
 * Weak entity tag of a response body
 * @public
 */
exports.entityTag = (body) => etag(body, { weak: true });

/**
 * Sends a json body straight on the raw response
 * @public
 */
exports.sendJson = (req, res, status, payload) => {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.setHeader('ETag', exports.entityTag(body));
  if (req.method === 'HEAD') res.end();
  else res.end(body);
};

const HEADER_NAMES = {
  'content-type': 'Content-Type',
  'content-length': 'Content-Length',
  'content-encoding': 'Content-Encoding',
  'content-security-policy': 'Content-Security-Policy',
  etag: 'ETag',
  location: 'Location',
  'www-authenticate': 'WWW-Authenticate',
};
const LEADING = ['content-type', 'content-length', 'etag'];
const TRAILING = ['content-encoding'];

const headerName = (name) => HEADER_NAMES[name]
  || name.replace(/(^|-)([a-z])/g, (match, dash, letter) => dash + letter.toUpperCase());

/**
 * Remembers the headers the pre-routing steps wrote: they stay first on the wire
 * @public
 */
exports.endOfFrontend = (res) => {
  res[kFrontend] = new Map(res.getHeaderNames().map((name) => [name, res.getHeader(name)]));
};

/**
 * Makes the response headers land on the wire the way express wrote them,
 * however fastify and its plugins set them: the pre-routing headers first and
 * unchanged, then canonical names with the body headers leading, the
 * compression Vary entry merged into an existing Vary header or appended, and
 * no body headers on a 204 or 304.
 * @public
 */
exports.expressHeaders = (res) => {
  const { writeHead } = res;
  res.writeHead = function expressWriteHead(statusCode, reason, headers) {
    let fields = headers;
    let message = reason;
    if (reason !== null && typeof reason === 'object') {
      fields = reason;
      message = undefined;
    }
    if (fields) Object.keys(fields).forEach((name) => this.setHeader(name, fields[name]));
    const frontend = this[kFrontend];
    if (frontend && (statusCode === 204 || statusCode === 304)) {
      this.removeHeader('Content-Type');
      this.removeHeader('Content-Length');
      this.removeHeader('Transfer-Encoding');
    }
    const entries = this.getRawHeaderNames().map((name) => [name, this.getHeader(name)]);
    const lower = (name) => name.toLowerCase();
    const early = entries.filter(([name]) => !frontend || frontend.has(lower(name)))
      .map(([name, value]) => [name, lower(name) === 'vary' && frontend ? frontend.get('vary') : value]);
    const late = entries.filter(([name]) => frontend && !frontend.has(lower(name)) && lower(name) !== 'vary')
      .map(([name, value]) => [lower(name), value]);
    const pick = (test) => late.filter(([name]) => test(name));
    entries.forEach(([name]) => this.removeHeader(name));
    [
      ...early,
      ...LEADING.flatMap((leading) => pick((name) => name === leading)),
      ...pick((name) => !LEADING.includes(name) && !TRAILING.includes(name)),
    ].forEach(([name, value]) => this.setHeader(frontend ? headerName(name) : name, value));
    const type = this.getHeader('Content-Type');
    const cacheControl = this.getHeader('Cache-Control');
    if (this[kCompressible] && type !== undefined && compressible(String(type))
      && !(cacheControl && /(?:^|,)\s*?no-transform\s*?(?:,|$)/.test(cacheControl))) {
      vary(this, 'Accept-Encoding');
    }
    pick((name) => TRAILING.includes(name))
      .forEach(([name, value]) => this.setHeader(headerName(name), value));
    return message === undefined
      ? writeHead.call(this, statusCode)
      : writeHead.call(this, statusCode, message);
  };
};
