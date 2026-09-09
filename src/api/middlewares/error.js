const httpStatus = require('http-status');
const ValidationError = require('../errors/validation-error');
const APIError = require('../errors/api-error');
const { env } = require('../../config/vars');

/**
 * Error handler. Send stacktrace only during development
 * @public
 */
const handler = (err, req, res) => {
  const response = {
    code: err.status,
    message: err.message || httpStatus[err.status],
    errors: err.errors,
    stack: err.stack,
  };

  if (env !== 'development') {
    delete response.stack;
  }

  res.status(err.status);
  res.json(response);
};
exports.handler = handler;

/**
 * If error is not an instanceOf APIError, convert it.
 * @public
 */
exports.converter = (err, req, res) => {
  let convertedError = err;

  if (err instanceof ValidationError) {
    convertedError = new APIError({
      message: 'Validation Error',
      errors: err.errors,
      status: err.status,
      // express-validation's ValidationError captured no stack, so the original
      // never put a "stack" field in a validation-error response. This class does
      // extend Error, so drop it here to keep the response body identical. The
      // error object itself keeps its stack for logging.
      stack: undefined,
    });
  } else if (!(err instanceof APIError)) {
    convertedError = new APIError({
      message: err.message,
      status: err.status || err.statusCode,
      stack: err.stack,
    });
  }

  return handler(convertedError, req, res);
};

/**
 * Catch 404 and forward to error handler
 * @public
 */
exports.notFound = (req, res) => {
  const err = new APIError({
    message: 'Not found',
    status: httpStatus.NOT_FOUND,
  });
  return handler(err, req, res);
};
