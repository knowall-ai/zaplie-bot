import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { HttpRequest } from '@azure/functions';
import {
  setLnbitUrl,
  getAccessToken,
  createInvoice,
  payInvoice,
  getUser,
  getUsers,
  resetState,
  getLnbitUrl,
} from './lnbitsService';

const makeRequest = (siteUrl = 'https://lnbits.example.com'): HttpRequest =>
  ({
    headers: {},
    query: { siteURL: siteUrl, adminkey: 'adminkey123' },
  }) as unknown as HttpRequest;

describe('functions/services/lnbitsService', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetState();
  });

  describe('setLnbitUrl', () => {
    test('extracts siteUrl and strips trailing slashes', () => {
      const req = makeRequest('https://lnbits.example.com///');
      setLnbitUrl(req);
      assert.equal(getLnbitUrl(), 'https://lnbits.example.com');
    });

    test('handles request without siteUrl', () => {
      const req = { headers: {}, query: {} } as unknown as HttpRequest;
      setLnbitUrl(req);
      assert.equal(getLnbitUrl(), null);
    });
  });

  describe('getAccessToken', () => {
    test('fetches token, caches it, and reuses on subsequent calls', async () => {
      let callCount = 0;
      globalThis.fetch = async (input, init) => {
        callCount++;
        assert.equal(input, 'https://lnbits.example.com/api/v1/auth');
        assert.equal(init?.method, 'POST');
        const body = JSON.parse(init?.body as string);
        assert.equal(body.username, 'alice');
        assert.equal(body.password, 'secret');
        return new Response(JSON.stringify({ access_token: 'tok-123' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      const req = makeRequest();
      const token1 = await getAccessToken(req, 'alice', 'secret');
      assert.equal(token1, 'tok-123');
      assert.equal(callCount, 1);

      // Second call should return cached token without invoking fetch again
      const token2 = await getAccessToken(req, 'alice', 'secret');
      assert.equal(token2, 'tok-123');
      assert.equal(callCount, 1);
    });

    test('fails if LNbits URL is not configured', async () => {
      const req = { headers: {}, query: {} } as unknown as HttpRequest;
      await assert.rejects(
        getAccessToken(req, 'alice', 'secret'),
        /LNbits URL is not configured/,
      );
    });

    test('rethrows on non-2xx HTTP response', async () => {
      globalThis.fetch = async () =>
        new Response('Unauthorized', {
          status: 401,
          statusText: 'Unauthorized',
        });

      const req = makeRequest();
      await assert.rejects(
        getAccessToken(req, 'alice', 'wrong-password'),
        /Error creating access token \(status: 401\)/,
      );
    });

    test('rethrows when response is not JSON', async () => {
      globalThis.fetch = async () =>
        new Response('<html>Error</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });

      const req = makeRequest();
      await assert.rejects(
        getAccessToken(req, 'alice', 'secret'),
        /Response is not in JSON format/,
      );
    });

    test('rethrows when access_token field is missing or empty', async () => {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ other_field: 'val' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });

      const req = makeRequest();
      await assert.rejects(
        getAccessToken(req, 'alice', 'secret'),
        /Access token is missing in the response/,
      );
    });

    test('isolates tokens by user credentials', async () => {
      let fetchCount = 0;
      globalThis.fetch = async (_input, init) => {
        fetchCount++;
        const body = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ access_token: `token-${body.username}` }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      const req = makeRequest();
      const aliceToken = await getAccessToken(req, 'alice', 'secret-a');
      assert.equal(aliceToken, 'token-alice');

      // Bob should fetch a new token, not reuse alice's
      const bobToken = await getAccessToken(req, 'bob', 'secret-b');
      assert.equal(bobToken, 'token-bob');
      assert.equal(fetchCount, 2);

      // Re-requesting alice should return cached alice token without fetching
      const aliceToken2 = await getAccessToken(req, 'alice', 'secret-a');
      assert.equal(aliceToken2, 'token-alice');
      assert.equal(fetchCount, 2);
    });

    test('isolates tokens by target site URL', async () => {
      let fetchCount = 0;
      globalThis.fetch = async (input) => {
        fetchCount++;
        return new Response(JSON.stringify({ access_token: `token-for-${input}` }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      const req1 = makeRequest('https://lnbits-one.example.com');
      const token1 = await getAccessToken(req1, 'alice', 'secret');
      assert.equal(token1, 'token-for-https://lnbits-one.example.com/api/v1/auth');

      const req2 = makeRequest('https://lnbits-two.example.com');
      const token2 = await getAccessToken(req2, 'alice', 'secret');
      assert.equal(token2, 'token-for-https://lnbits-two.example.com/api/v1/auth');
      assert.equal(fetchCount, 2);
    });
  });

  describe('createInvoice', () => {
    test('creates invoice and returns payment_request string', async () => {
      globalThis.fetch = async (input, init) => {
        assert.equal(input, 'https://lnbits.example.com/api/v1/payments');
        assert.equal(init?.method, 'POST');
        assert.equal((init?.headers as Record<string, string>)['X-Api-Key'], 'inkey-456');
        const body = JSON.parse(init?.body as string);
        assert.equal(body.out, false);
        assert.equal(body.amount, 21);
        assert.equal(body.memo, 'test memo');
        assert.equal(body.unit, 'sat');
        assert.deepEqual(body.extra, { tag: 'zap' });
        return new Response(
          JSON.stringify({
            payment_hash: 'hash123',
            payment_request: 'lnbc210n1testinvoice',
            checking_id: 'check123',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      };

      const req = makeRequest();
      const invoice = await createInvoice(
        req,
        'inkey-456',
        'wallet-target',
        21,
        'test memo',
        { tag: 'zap' },
      );
      assert.equal(invoice, 'lnbc210n1testinvoice');
    });

    test('rethrows on non-2xx HTTP response (does not return Error object)', async () => {
      globalThis.fetch = async () =>
        new Response('Service Unavailable', { status: 503 });

      const req = makeRequest();
      await assert.rejects(
        createInvoice(req, 'inkey-456', 'wallet-target', 21, 'memo', {}),
        (err: unknown) => {
          assert(err instanceof Error);
          assert.match(err.message, /Error creating an invoice \(status: 503\)/);
          return true;
        },
      );
    });

    test('rethrows when payment_request is missing in response', async () => {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ error: 'something went wrong' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });

      const req = makeRequest();
      await assert.rejects(
        createInvoice(req, 'inkey-456', 'wallet-target', 21, 'memo', {}),
        /createInvoice: LNbits did not return a valid payment_request/,
      );
    });

    test('rethrows when response is an array', async () => {
      globalThis.fetch = async () =>
        new Response(JSON.stringify([{ payment_request: 'invoice' }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });

      const req = makeRequest();
      await assert.rejects(
        createInvoice(req, 'inkey-456', 'wallet-target', 21, 'memo', {}),
        /createInvoice: LNbits did not return a valid payment_request/,
      );
    });

    test('rethrows network error', async () => {
      globalThis.fetch = async () => {
        throw new Error('Connection reset');
      };

      const req = makeRequest();
      await assert.rejects(
        createInvoice(req, 'inkey-456', 'wallet-target', 21, 'memo', {}),
        /Connection reset/,
      );
    });
  });

  describe('payInvoice', () => {
    test('pays invoice and returns payment result object', async () => {
      globalThis.fetch = async (input, init) => {
        assert.equal(input, 'https://lnbits.example.com/api/v1/payments');
        assert.equal(init?.method, 'POST');
        assert.equal((init?.headers as Record<string, string>)['X-Api-Key'], 'adminkey-789');
        const body = JSON.parse(init?.body as string);
        assert.equal(body.out, true);
        assert.equal(body.bolt11, 'lnbc210n1testinvoice');
        assert.deepEqual(body.extra, { tag: 'zap' });
        return new Response(
          JSON.stringify({ payment_hash: 'paidhash456' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      };

      const req = makeRequest();
      const result = await payInvoice(
        req,
        'adminkey-789',
        'lnbc210n1testinvoice',
        { tag: 'zap' },
      );
      assert.equal(result.payment_hash, 'paidhash456');
    });

    test('rethrows on non-2xx HTTP response', async () => {
      globalThis.fetch = async () =>
        new Response('Payment Required', { status: 402 });

      const req = makeRequest();
      await assert.rejects(
        payInvoice(req, 'adminkey-789', 'lnbc210n1testinvoice', {}),
        /Error paying invoice \(status: 402\)/,
      );
    });

    test('rethrows when response is not an object', async () => {
      globalThis.fetch = async () =>
        new Response('null', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });

      const req = makeRequest();
      await assert.rejects(
        payInvoice(req, 'adminkey-789', 'lnbc210n1testinvoice', {}),
        /payInvoice: LNbits did not return a valid payment response/,
      );
    });

    test('rethrows when response is an array', async () => {
      globalThis.fetch = async () =>
        new Response(JSON.stringify([{ payment_hash: 'paidhash456' }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });

      const req = makeRequest();
      await assert.rejects(
        payInvoice(req, 'adminkey-789', 'lnbc210n1testinvoice', {}),
        /payInvoice: LNbits did not return a valid payment response/,
      );
    });

    test('rethrows when payment_hash is missing', async () => {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ status: 'success' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });

      const req = makeRequest();
      await assert.rejects(
        payInvoice(req, 'adminkey-789', 'lnbc210n1testinvoice', {}),
        /payInvoice: LNbits did not return a valid payment response/,
      );
    });

    test('rethrows when payment_hash is empty string', async () => {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ payment_hash: '' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });

      const req = makeRequest();
      await assert.rejects(
        payInvoice(req, 'adminkey-789', 'lnbc210n1testinvoice', {}),
        /payInvoice: LNbits did not return a valid payment response/,
      );
    });

    test('rethrows when payment_hash is not a string', async () => {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ payment_hash: 12345 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });

      const req = makeRequest();
      await assert.rejects(
        payInvoice(req, 'adminkey-789', 'lnbc210n1testinvoice', {}),
        /payInvoice: LNbits did not return a valid payment response/,
      );
    });
  });

  describe('getUser and getUsers', () => {
    test('getUser throws descriptive LNbits v1+ deprecation error', async () => {
      const req = makeRequest();
      await assert.rejects(
        getUser(req, 'user-1', 'admin-key'),
        /getUser is not supported by LNbits v1\+ core API/,
      );
    });

    test('getUsers throws descriptive LNbits v1+ deprecation error', async () => {
      const req = makeRequest();
      await assert.rejects(
        getUsers(req, 'admin-key'),
        /getUsers is not supported by LNbits v1\+ core API/,
      );
    });
  });
});
