// make bluebird default Promise
Promise = require('bluebird'); // eslint-disable-line no-global-assign
const { port, env } = require('./config/vars');
const logger = require('./config/logger');
const app = require('./config/fastify');
const mongoose = require('./config/mongoose');

// open mongoose connection
mongoose.connect();

// listen to requests
const started = app.listen({ port, host: '0.0.0.0' })
  .then(() => logger.info(`server started on port ${port} (${env})`))
  .catch((err) => {
    logger.error(err);
    process.exit(1);
  });

/**
* Exports fastify
* @public
*/
module.exports = app;
module.exports.started = started;
