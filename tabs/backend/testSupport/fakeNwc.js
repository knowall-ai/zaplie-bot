// A fake NWC wallet service for tests: an in-memory wallet per connection
// string, speaking the @getalby/sdk NWCClient method surface the adapter uses
// (getInfo, getBalance, getBudget, payInvoice, makeInvoice, lookupInvoice,
// listTransactions, close). Amounts are msat on the wire, as in NIP-47.
const crypto = require('crypto');
const { createNwcWalletFactory } = require('../nwcWallet');

const ALL_METHODS = ['get_info', 'get_balance', 'pay_invoice', 'make_invoice', 'lookup_invoice', 'list_transactions'];

const nwcUrlFor = (seed, relay = 'wss://bank.example/nostrclient/api/v1/relay') =>
  `nostr+walletconnect://${crypto.createHash('sha256').update(`pub${seed}`).digest('hex')}` +
  `?relay=${encodeURIComponent(relay)}&secret=${crypto.createHash('sha256').update(`sec${seed}`).digest('hex')}`;

class FakeWalletError extends Error {
  constructor(code) {
    super(`wallet error ${code}`);
    this.name = 'Nip47WalletError';
    this.code = code;
  }
}

const createFakeNwc = ({ env = { LNBITS_URL: 'https://bank.example' } } = {}) => {
  const wallets = new Map();
  const calls = [];

  const add = (url, { balanceSats = 0, methods = ALL_METHODS, pay, transactions = [], budget } = {}) => {
    const wallet = { url, balanceMsat: balanceSats * 1000, methods, pay, transactions, budget, closed: 0 };
    wallets.set(url, wallet);
    return wallet;
  };

  const clientFactory = (url) => {
    const wallet = wallets.get(url);
    const record = (method, params) => {
      calls.push({ url, method, params });
      if (!wallet) throw Object.assign(new Error('relay unreachable'), { name: 'Nip47NetworkError' });
    };
    return {
      getInfo: async () => {
        record('get_info');
        return { alias: 'fake', methods: wallet.methods };
      },
      getBalance: async () => {
        record('get_balance');
        return { balance: wallet.balanceMsat };
      },
      getBudget: async () => {
        record('get_budget');
        return wallet.budget || {};
      },
      makeInvoice: async (params) => {
        record('make_invoice', params);
        const hash = crypto.randomBytes(32).toString('hex');
        return { invoice: `lnbc${params.amount / 1000}0n1pfake${hash.slice(0, 8)}`, payment_hash: hash };
      },
      payInvoice: async (params) => {
        record('pay_invoice', params);
        if (wallet.pay) return wallet.pay(params, wallet);
        const preimage = crypto.randomBytes(32).toString('hex');
        return { preimage, fees_paid: 0 };
      },
      lookupInvoice: async (params) => {
        record('lookup_invoice', params);
        if (wallet.lookup) return wallet.lookup(params);
        throw new FakeWalletError('NOT_FOUND');
      },
      listTransactions: async (params) => {
        record('list_transactions', params);
        return { transactions: wallet.transactions };
      },
      close: () => {
        if (wallet) wallet.closed += 1;
      },
    };
  };

  const factory = createNwcWalletFactory({ clientFactory, env, timeoutMs: 200, payTimeoutMs: 200 });
  return { add, calls, factory, wallets, FakeWalletError };
};

module.exports = { ALL_METHODS, FakeWalletError, createFakeNwc, nwcUrlFor };
