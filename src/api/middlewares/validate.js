const Joi = require('joi');
const assignIn = require('lodash/assignIn');
const find = require('lodash/find');
const defaults = require('lodash/defaults');
const ValidationError = require('../errors/validation-error');

const defaultOptions = {
  contextRequest: false,
  allowUnknownHeaders: true,
  allowUnknownBody: true,
  allowUnknownQuery: true,
  allowUnknownParams: true,
  allowUnknownCookies: true,
  status: 400,
  statusText: 'Bad Request',
};

const unknownMap = {
  headers: 'allowUnknownHeaders',
  body: 'allowUnknownBody',
  query: 'allowUnknownQuery',
  params: 'allowUnknownParams',
  cookies: 'allowUnknownCookies',
};

/**
 * Validates a single request source against its schema, collecting one entry
 * per offending field and writing the coerced values back onto the request.
 * @private
 */
const validateSource = (errObj, request, schema, location, allowUnknown, context) => {
  if (!request || !schema) return;

  const joiOptions = {
    context: context || request,
    allowUnknown,
    abortEarly: false,
  };

  Joi.validate(request, schema, joiOptions, (errors, value) => {
    if (!errors || errors.details.length === 0) {
      assignIn(request, value); // joi responses are parsed into JSON
      return;
    }
    errors.details.forEach((error) => {
      const errorExists = find(errObj, (item) => {
        if (item && item.field === error.path && item.location === location) {
          item.messages.push(error.message);
          item.types.push(error.type);
          return item;
        }
        return undefined;
      });

      if (!errorExists) {
        errObj.push({
          field: error.path,
          location,
          messages: [error.message],
          types: [error.type],
        });
      }
    });
  });
};

/**
 * Builds a fastify preHandler that validates headers, body, query, params and
 * cookies against the given schema.
 * @public
 */
module.exports = (schema) => {
  if (!schema) throw new Error('Please provide a validation schema');

  return (req, res, next) => {
    const errors = [];
    const options = defaults({}, schema.options || {}, defaultOptions);

    ['headers', 'body', 'query', 'params', 'cookies'].forEach((key) => {
      const allowUnknown = options[unknownMap[key]];
      const entireContext = options.contextRequest ? req : null;
      if (schema[key]) {
        validateSource(errors, req[key], schema[key], key, allowUnknown, entireContext);
      }
    });

    if (errors && errors.length === 0) return next();

    return next(new ValidationError(errors, options));
  };
};
