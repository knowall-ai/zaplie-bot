const assert = require('node:assert/strict');
const test = require('node:test');
const {
  allowedAddressDomains,
  bolt11AmountMsat,
  parseLightningAddress,
  requestInvoice,
} = require('./lnurlPay');

const ENV = { LNBITS_URL: 'https://bank.example' };

const json = (body, status = 200) => ({
  ok: status < 400,
  status,
  text: async () => JSON.stringify(body),
});

const payRequest = (overrides = {}) => ({
  tag: 'payRequest',
  callback: 'https://bank.example/lnurlp/api/v1/lnurl/cb/abc',
  minSendable: 1000,
  maxSendable: 100_000_000,
  commentAllowed: 50,
  ...overrides,
});

test('BOLT 11 amounts are read from the human-readable part', () => {
  assert.equal(bolt11AmountMsat('lnbc200n1pdeadbeef'), 20_000);
  assert.equal(bolt11AmountMsat('lnbc20u1pdeadbeef'), 2_000_000);
  assert.equal(bolt11AmountMsat('lnbc2500u1pdeadbeef'), 250_000_000);
  assert.equal(bolt11AmountMsat('lnbc1m1pdeadbeef'), 100_000_000);
  assert.equal(bolt11AmountMsat('lnbc10p1pdeadbeef'), 1);
  assert.equal(bolt11AmountMsat('lnbcrt100n1pdeadbeef'), 10_000);
  assert.equal(bolt11AmountMsat('lntb5u1pdeadbeef'), 500_000);
  assert.equal(bolt11AmountMsat('lnbc1pdeadbeef'), null);
  assert.throws(() => bolt11AmountMsat('lnbc15p1pdeadbeef'), /sub-millisatoshi/);
  assert.throws(() => bolt11AmountMsat('not-an-invoice'), /unreadable/);
});

test('only the public LNbits host is accepted by default', () => {
  assert.deepEqual([...allowedAddressDomains(ENV)], ['bank.example']);
  assert.equal(parseLightningAddress(' Ada@Bank.Example ', ENV).address, 'ada@bank.example');
  assert.throws(() => parseLightningAddress('ada@wallet.other', ENV), (error) => error.status === 400);
  assert.throws(() => parseLightningAddress('ada@10.0.0.1', { ZAPLIE_LIGHTNING_ADDRESS_DOMAINS: '*' }), /domain name/);
  assert.throws(() => parseLightningAddress('not an address', ENV), (error) => error.status === 400);
  assert.equal(
    parseLightningAddress('ada@wallet.other', { ZAPLIE_LIGHTNING_ADDRESS_DOMAINS: 'bank.example, wallet.other' }).domain,
    'wallet.other',
  );
});

test('an invoice is requested for the exact amount and checked before it is returned', async () => {
  const urls = [];
  const fetchImpl = async (url, init) => {
    urls.push(url);
    assert.equal(init.redirect, 'error');
    if (url.includes('/.well-known/lnurlp/ada')) return json(payRequest());
    return json({ pr: 'lnbc200n1pdeadbeef', routes: [] });
  };
  const pr = await requestInvoice('ada@bank.example', 20, 'thanks for the review', { env: ENV, fetchImpl });
  assert.equal(pr, 'lnbc200n1pdeadbeef');
  const callback = new URL(urls[1]);
  assert.equal(callback.searchParams.get('amount'), '20000');
  assert.equal(callback.searchParams.get('comment'), 'thanks for the review');
});

test('an invoice for a different amount is refused', async () => {
  const fetchImpl = async (url) =>
    url.includes('/.well-known/') ? json(payRequest()) : json({ pr: 'lnbc2500u1pdeadbeef' });
  await assert.rejects(
    requestInvoice('ada@bank.example', 20, '', { env: ENV, fetchImpl }),
    /wrong amount/,
  );
});

test('a callback on another host is refused before it is called', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return json(payRequest({ callback: 'https://evil.example/cb' }));
  };
  await assert.rejects(
    requestInvoice('ada@bank.example', 20, '', { env: ENV, fetchImpl }),
    /another host/,
  );
  assert.equal(calls, 1);
});

test('amounts outside the address limits are a 409 with the limits named', async () => {
  const fetchImpl = async () => json(payRequest({ minSendable: 50_000 }));
  await assert.rejects(
    requestInvoice('ada@bank.example', 20, '', { env: ENV, fetchImpl }),
    (error) => error.status === 409 && /50 to/.test(error.message),
  );
});

test('an address that is not a pay request is refused', async () => {
  const fetchImpl = async () => json({ tag: 'withdrawRequest' });
  await assert.rejects(
    requestInvoice('ada@bank.example', 20, '', { env: ENV, fetchImpl }),
    (error) => error.status === 400,
  );
});
