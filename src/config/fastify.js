const http = require('http');
const Fastify = require('fastify');
const morgan = require('morgan');
const methodOverride = require('method-override');
const passport = require('passport');
const httpStatus = require('http-status');
const routes = require('../api/routes/v1');
const { logs } = require('./vars');
const strategies = require('./passport');
const error = require('../api/middlewares/error');
const layer = require('./http-layer');

const requestLogger = morgan(logs);
const overrideMethod = methodOverride();
const initializePassport = passport.initialize();

/**
 * A raw response with the reply methods the error middleware calls
 * @private
 */
const rawReply = (req, res) => ({
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    layer.sendJson(req, res, this.statusCode, payload);
    return this;
  },
});

/**
 * Everything the express stack did before routing, in the same order: request
 * logging, body parsing, method overriding, security headers, CORS and passport.
 * A body that cannot be parsed is answered right away, before any of the later
 * steps has touched the response -- express still advertised itself on it.
 * @private
 */
const frontend = (handler) => (req, res) => {
  res.setHeader('X-Powered-By', 'Express');
  layer.expressHeaders(res);
  requestLogger(req, res, () => layer.parseBody(req, res, (parseError) => {
    if (parseError) {
      error.converter(parseError, req, rawReply(req, res));
      return;
    }
    layer.markCompressible(res);
    overrideMethod(req, res, () => {
      layer.securityHeaders(req, res);
      if (layer.cors(req, res)) return;
      layer.endOfFrontend(res);
      layer.routableMethod(req);
      initializePassport(req, res, () => handler(req, res));
    });
  }));
};

/**
* Fastify instance
* @public
*/
const app = Fastify({
  logger: false,
  // express routing: case-insensitive, trailing slash optional, a semicolon is
  // part of the path and route parameters have no length limit
  caseSensitive: false,
  ignoreTrailingSlash: true,
  useSemicolonDelimiter: false,
  maxParamLength: Number.MAX_SAFE_INTEGER,
  // the router sees the path the express router matched against
  rewriteUrl: (req) => layer.routingUrl(req.url),
  querystringParser: layer.parseQuery,
  serverFactory: (handler) => http.createServer(frontend(handler)),
  // a request node cannot parse is answered the way node answers it on its own
  clientErrorHandler: layer.clientError,
});

// bodies were parsed before routing, for every method
app.removeAllContentTypeParsers();
app.addContentTypeParser('*', (request, payload, done) => done(null, request.raw.body));
// route parameters are decoded once a route matched, as express did; one that
// does not decode is a 400 in the api error format
app.addHook('onRequest', (request, reply, done) => {
  layer.restoreMethod(request.raw);
  try {
    layer.decodeParams(request.params);
  } catch (err) {
    done(err);
    return;
  }
  done();
});
app.addHook('preValidation', (request, reply, done) => {
  request.body = request.raw.body;
  // connect-style middlewares (passport strategies) read the parsed query off
  // the raw request, the way express leaves it
  request.raw.query = request.query;
  done();
});

// res.json() writes the payload with express' semantics: compact JSON with a
// json content type, whatever the payload's type is
app.decorateReply('json', function json(payload) {
  this.type('application/json; charset=utf-8');
  return this.send(JSON.stringify(payload));
});

// entity tags on every body, and 304 for a GET or HEAD the client already has
app.addHook('onSend', (request, reply, payload, done) => {
  if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) return done(null, payload);
  if (!reply.hasHeader('etag')) reply.header('etag', layer.entityTag(payload));
  if (layer.isFresh(request.raw.method, reply.statusCode, request.headers, reply.getHeader('etag'))) {
    reply.code(httpStatus.NOT_MODIFIED);
    return done(null, '');
  }
  return done(null, payload);
});

// gzip compression
app.addHook('onSend', (request, reply, payload, done) => layer.compress(request.raw, reply, payload, done));

passport.use('jwt', strategies.jwt);
passport.use('facebook', strategies.facebook);
passport.use('google', strategies.google);

// mount api v1 routes
app.register(routes, { prefix: '/v1' });

// if error is not an instanceOf APIError, convert it.
app.setErrorHandler(error.converter);

// catch 404 and forward to error handler
app.setNotFoundHandler(error.notFound);

module.exports = app;
