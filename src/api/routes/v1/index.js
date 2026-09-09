const fs = require('fs');
const path = require('path');
const fastifyStatic = require('@fastify/static');
const userRoutes = require('./user.route');
const authRoutes = require('./auth.route');

const escapeHtml = (value) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const redirectBody = (href) => [
  '<!DOCTYPE html>',
  '<html lang="en">',
  '<head>',
  '<meta charset="utf-8">',
  '<title>Redirecting</title>',
  '</head>',
  '<body>',
  `<pre>Redirecting to <a href="${href}">${href}</a></pre>`,
  '</body>',
  '</html>',
  '',
].join('\n');

module.exports = async (fastify) => {
  /**
   * GET v1/status
   */
  fastify.get('/status', (req, res) => res.type('text/html; charset=utf-8').send('OK'));

  /**
   * GET v1/docs
   */
  const docs = path.join(process.cwd(), 'docs');
  if (fs.existsSync(docs)) {
    // express.static answers a directory request that lacks the trailing slash with
    // a 301 to the slashed url, and writes its own content security policy on it
    fastify.get('/docs', (req, res) => {
      const location = req.raw.url.replace(/^([^?]*)/, '$1/');
      const href = escapeHtml(location);
      return res
        .code(301)
        .header('Content-Security-Policy', "default-src 'none'")
        .header('Location', location)
        .type('text/html; charset=UTF-8')
        .send(redirectBody(href));
    });
    fastify.register(fastifyStatic, { root: docs, prefix: '/docs/' });
  }

  fastify.register(userRoutes, { prefix: '/users' });
  fastify.register(authRoutes, { prefix: '/auth' });
};
