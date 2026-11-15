// filepath: tabs/backend/walletErrors.js
// The error every wallet-facing module throws, whatever the wallet backend.
// `status` is the HTTP status the router answers with; 5xx messages are
// masked unless `expose` opts one back in (when the person must be told
// something specific rather than "try again").
class WalletGatewayError extends Error {
  constructor(message, status = 502, { expose = false } = {}) {
    super(message);
    this.name = 'WalletGatewayError';
    this.status = status;
    this.expose = expose;
  }
}

module.exports = { WalletGatewayError };
