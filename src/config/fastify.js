const http = require('http');
const Fastify = require('fastify');
const compress = require('@fastify/compress');
const helmet = require('@fastify/helmet');
const cors = require('@fastify/cors');
const formbody = require('@fastify/formbody');
const morgan = require('morgan');
const methodOverride = require('method-override');
const passport = require('passport');
const routes = require('../api/routes/v1');
const { logs } = require('./vars');
const strategies = require('./passport');
const error = require('../api/middlewares/error');

const requestLogger = morgan(logs);
const overrideMethod = methodOverride();
const initializePassport = passport.initialize();

/**
* Fastify instance
* @public
*/
const app = Fastify({
  logger: false,
  // request logging and method overriding have to happen before routing,
  // so they wrap the raw node handler instead of running as fastify hooks
  serverFactory: (handler) => http.createServer((req, res) => {
    requestLogger(req, res, () => overrideMethod(req, res, () => handler(req, res)));
  }),
});

// express' body parsers always leave an object behind, even when the request
// carries no payload at all; fastify leaves it undefined, which would make the
// validation middleware skip the body entirely
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  if (!body || body.trim().length === 0) return done(null, {});
  try {
    return done(null, JSON.parse(body));
  } catch (err) {
    err.status = 400;
    return done(err);
  }
});
app.addContentTypeParser(['text/plain', '*'], (req, payload, done) => done(null, {}));
app.addHook('preValidation', (request, reply, done) => {
  if (request.body === undefined || request.body === null) request.body = {};
  // connect-style middlewares (passport strategies) read the parsed body and
  // query off the raw request, the way express leaves them
  request.raw.body = request.body;
  request.raw.query = request.query;
  // helmet is mounted *after* the body parsers in the express stack, so a
  // payload that fails to parse never reaches it. Reproduce that by applying
  // it here instead of at onRequest -- see the app.register(helmet) note below.
  if (typeof reply.helmet === 'function') reply.helmet();
  done();
});

// res.json() writes the payload with express' semantics: compact JSON with a
// json content type, whatever the payload's type is
app.decorateReply('json', function json(payload) {
  this.type('application/json; charset=utf-8');
  return this.send(JSON.stringify(payload));
});

// gzip compression
app.register(compress);

// parse urlencoded bodies
app.register(formbody);

// secure apps by setting various HTTP headers.
// @fastify/helmet bundles helmet 7, whose default content security policy differs
// from the helmet 4 the original ran: helmet 7 dropped block-all-mixed-content and
// added form-action. Spell the directives out so the header stays byte-identical.
// @fastify/helmet's own hook is onRequest, which runs before the payload is
// parsed, so it would decorate the 400 that a malformed JSON body produces --
// express never does, because express short-circuits from body-parser straight
// to the error handler and skips every middleware mounted after it, helmet
// included. Register non-globally and invoke it from the preValidation hook
// above: preValidation is the first lifecycle point reached only once the
// payload has parsed, so every other response keeps the headers unchanged.
app.register(helmet, {
  global: false,
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      'default-src': ["'self'"],
      'base-uri': ["'self'"],
      'block-all-mixed-content': [],
      'font-src': ["'self'", 'https:', 'data:'],
      'frame-ancestors': ["'self'"],
      'img-src': ["'self'", 'data:'],
      'object-src': ["'none'"],
      'script-src': ["'self'"],
      'script-src-attr': ["'none'"],
      'style-src': ["'self'", 'https:', "'unsafe-inline'"],
      'upgrade-insecure-requests': [],
    },
  },
});

// enable CORS - Cross Origin Resource Sharing
// express' cors() answers every OPTIONS request, not only well-formed preflights
app.register(cors, { strictPreflight: false });

// enable authentication
app.addHook('onRequest', (request, reply, done) => {
  initializePassport(request.raw, reply.raw, done);
});
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
