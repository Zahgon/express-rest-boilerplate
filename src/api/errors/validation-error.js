const map = require('lodash/map');
const flatten = require('lodash/flatten');

/**
 * Error raised by the validation middleware, carrying one entry per invalid
 * request source.
 * @extends Error
 */
class ValidationError extends Error {
  /**
   * Creates an API error.
   * @param {Array} errors - Errors collected by the validation middleware.
   * @param {Object} options - Options used by the validation middleware.
   */
  constructor(errors, options) {
    super('validation error');
    this.name = 'ValidationError';
    this.message = 'validation error';
    this.errors = errors;
    this.flatten = options.flatten;
    this.status = options.status;
    this.statusText = options.statusText;
  }

  toJSON() {
    if (this.flatten) return flatten(map(this.errors, 'messages'));
    return {
      status: this.status,
      statusText: this.statusText,
      errors: this.errors,
    };
  }

  toString() {
    return JSON.stringify(this.toJSON());
  }
}

module.exports = ValidationError;
