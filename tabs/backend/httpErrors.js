// filepath: tabs/backend/httpErrors.js
// How the backend answers what no route handled, and what a route threw.
//   * Unknown /api/* and /internal/* paths: JSON 404 {error: 'not_found'},
//     never the portal's index.html with a 200.
//   * Anything thrown and not answered: JSON with a short correlation id the
//     person can quote; the details (stack included) go to the server log
//     only. No stack or internal message ever reaches a response.
//   * Client error reports (POST /api/client-errors): the portal's error page
//     logs its reference id here, so support can find it in App Service logs.
const crypto = require('crypto');

const MAX_FIELD = 300;
const KEY_LIKE = /[0-9a-f]{32,}/gi;
const NWC_LIKE = /nostr\+walletconnect:\/\/\S+/gi;
const REFERENCE = /^[A-Z0-9]{8}$/;

const correlationId = () => crypto.randomBytes(5).toString('hex').toUpperCase().slice(0, 8);

// Free text from a request or an error can carry a key or a connection
// string; neither is ever logged.
const scrub = (value) =>
  String(value ?? '')
    .replace(NWC_LIKE, '[redacted]')
    .replace(KEY_LIKE, '[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, MAX_FIELD);

const notFoundJson = (_req, res) => {
  res.status(404).json({ error: 'not_found' });
};

/** The last middleware: JSON, a correlation id, no stack. */
const createErrorHandler = ({ log = console.error } = {}) =>
  // Express recognises an error handler by its four parameters.
  // eslint-disable-next-line no-unused-vars
  (error, req, res, next) => {
    const id = correlationId();
    const status =
      Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    log('Unhandled request error', id, req.method, scrub(String(req.originalUrl || req.url).split('?')[0]), scrub(error?.stack || error?.message));
    if (res.headersSent) {
      res.end();
      return;
    }
    res.set('X-Correlation-Id', id);
    res.status(status).json({
      error: status >= 500 ? 'internal_error' : status === 404 ? 'not_found' : 'bad_request',
      correlationId: id,
    });
  };

const clientErrorRoute = ({ log = console.error } = {}) => (req, res) => {
  const { referenceId, kind, route, message } = req.body || {};
  if (typeof referenceId !== 'string' || !REFERENCE.test(referenceId)) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  log('Portal client error', referenceId, scrub(kind), scrub(route), scrub(message));
  res.status(204).end();
};

module.exports = { clientErrorRoute, correlationId, createErrorHandler, notFoundJson, scrub };
