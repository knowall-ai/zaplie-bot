import express from 'express';
import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import { createHash } from 'crypto';
import {
  createRewardsRouter,
  isAuthorizedRewardKey,
  RewardsRouteDeps,
} from './rewardsRoute';
import { getWebhookKeyHashes } from './services/fetchWebhookKeys';
import { RewardLedger, rewardKey } from './services/rewardLedger';
import { RewardError } from './services/rewardsService';
import {
  createInvoice,
  getUserWalletsByUserId,
  payInvoice,
} from './services/lnbitsService';
import { resolveRewardRecipientByGithubId } from './services/identityService';
import {
  createPendingReward,
  PendingRewardWriteUncertainError,
} from './services/pendingRewardsService';

// The real payReward runs; only its LNbits and portal calls are stubbed, so
// "payInvoice was called once" means the treasury paid once.
jest.mock('./services/lnbitsService', () => ({
  getUserWalletsByUserId: jest.fn(),
  createInvoice: jest.fn(),
  payInvoice: jest.fn(),
}));
jest.mock('./services/identityService', () => ({
  resolveRewardRecipientByGithubId: jest.fn(),
}));
jest.mock('./services/pendingRewardsService', () => ({
  ...jest.requireActual<object>('./services/pendingRewardsService'),
  createPendingReward: jest.fn(),
}));
jest.mock('./services/fetchWebhookKeys', () => ({
  getWebhookKeyHashes: jest.fn(),
}));

type AsyncMock = jest.Mock<(...args: unknown[]) => Promise<unknown>>;
const mockedPayInvoice = payInvoice as unknown as AsyncMock;
const mockedCreateInvoice = createInvoice as unknown as AsyncMock;
const mockedGetWallets = getUserWalletsByUserId as unknown as AsyncMock;
const mockedResolveRecipient =
  resolveRewardRecipientByGithubId as unknown as AsyncMock;
const mockedCreatePendingReward = createPendingReward as unknown as AsyncMock;

const API_KEY = 'test-api-key';
const validBody = {
  recipient: 'octocat',
  recipientId: 583231,
  eventType: 'githubPrMerged',
  repo: 'octo-org/octo-repo',
  reason: 'GitHub: PR #7 merged',
  source: 'github',
};
const paidBody = {
  status: 'paid',
  paymentHash: 'hash-1',
  recipient: 'octocat',
  amountSats: 21,
};

const tempDirectories: string[] = [];
const servers: http.Server[] = [];
let storePath: string;
let ledger: RewardLedger;
let deps: {
  isAuthorizedRewardKey: jest.Mock<(key: string) => Promise<boolean>>;
  assertRepoConnected: jest.Mock<(repo: string) => Promise<void>>;
  resolveAmountSats: jest.Mock<() => Promise<number>>;
  recordRewardOutcome: jest.Mock<(outcome: unknown) => void>;
};
const savedTreasuryKey = process.env.REWARDS_TREASURY_ADMINKEY;

const startServer = async (
  overrides: Partial<RewardsRouteDeps> = {},
): Promise<string> => {
  const app = express();
  app.use(express.json());
  app.use(
    createRewardsRouter({
      ledger,
      ...(deps as unknown as Partial<RewardsRouteDeps>),
      ...overrides,
    }),
  );
  const server = await new Promise<http.Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/api/v1/rewards`;
};

interface PostOptions {
  idempotencyKey?: string | null;
  body?: unknown;
  apiKey?: string;
}

const post = async (
  url: string,
  {
    idempotencyKey = 'delivery-1',
    body = validBody,
    apiKey = API_KEY,
  }: PostOptions = {},
) => {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
  };
  if (idempotencyKey !== null) {
    headers['idempotency-key'] = idempotencyKey;
  }
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    text: await response.text(),
    replayed: response.headers.get('idempotency-replayed'),
  };
};

beforeEach(() => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-rewards-'));
  tempDirectories.push(directory);
  storePath = path.join(directory, 'bot-reward-ledger.json');
  ledger = new RewardLedger({ storePath, lockRetryMs: 1 });
  deps = {
    isAuthorizedRewardKey: jest.fn(async (key: string) => key === API_KEY),
    assertRepoConnected: jest.fn(async () => undefined),
    resolveAmountSats: jest.fn(async () => 21),
    recordRewardOutcome: jest.fn(),
  };
  process.env.REWARDS_TREASURY_ADMINKEY = 'treasury-admin-key';
  mockedResolveRecipient.mockResolvedValue({ lnbitsUserId: 'user-1' });
  mockedGetWallets.mockResolvedValue([
    { id: 'wallet-private', name: 'Private', user: 'user-1', inkey: 'in' },
  ]);
  mockedCreateInvoice.mockResolvedValue('lnbc-invoice');
  mockedPayInvoice.mockResolvedValue({ payment_hash: 'hash-1' });
  mockedCreatePendingReward.mockResolvedValue(undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await Promise.all(
    servers
      .splice(0)
      .map(server => new Promise(resolve => server.close(resolve))),
  );
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  if (savedTreasuryKey === undefined) {
    delete process.env.REWARDS_TREASURY_ADMINKEY;
  } else {
    process.env.REWARDS_TREASURY_ADMINKEY = savedTreasuryKey;
  }
});

describe('POST /api/v1/rewards idempotency', () => {
  test('a missing Idempotency-Key is a 400 and touches nothing', async () => {
    const url = await startServer();

    const response = await post(url, { idempotencyKey: null });

    expect(response.status).toBe(400);
    expect(JSON.parse(response.text)).toEqual({
      error: 'Idempotency-Key header is required',
    });
    expect(fs.existsSync(storePath)).toBe(false);
    expect(mockedPayInvoice).not.toHaveBeenCalled();
  });

  test.each([
    ['too long', 'x'.repeat(257)],
    ['a tab inside it', 'delivery\t1'],
    ['a non-ASCII character', 'delivery-é'],
  ])('an Idempotency-Key with %s is a 400', async (_label, idempotencyKey) => {
    const url = await startServer();

    const response = await post(url, { idempotencyKey });

    expect(response.status).toBe(400);
    expect(JSON.parse(response.text)).toEqual({
      error: 'Idempotency-Key header is invalid',
    });
    expect(fs.existsSync(storePath)).toBe(false);
  });

  test('an invalid API key never touches the ledger', async () => {
    const reserve = jest.spyOn(ledger, 'reserve');
    const url = await startServer();

    const response = await post(url, { apiKey: 'wrong' });

    expect(response.status).toBe(401);
    expect(reserve).not.toHaveBeenCalled();
    expect(fs.existsSync(storePath)).toBe(false);
  });

  test('an invalid body is a 400 before any ledger write', async () => {
    const url = await startServer();

    const response = await post(url, {
      body: { ...validBody, source: 'timesheet' },
    });

    expect(response.status).toBe(400);
    expect(fs.existsSync(storePath)).toBe(false);
  });

  test('the first request pays once and returns 200', async () => {
    const url = await startServer();

    const response = await post(url);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toEqual(paidBody);
    expect(response.replayed).toBeNull();
    expect(mockedPayInvoice).toHaveBeenCalledTimes(1);
    expect(deps.recordRewardOutcome).toHaveBeenCalledWith({
      status: 'paid',
      paymentHash: 'hash-1',
      sats: 21,
    });
    await expect(
      new RewardLedger({ storePath }).get(rewardKey('delivery-1')),
    ).resolves.toMatchObject({ state: 'paid', response: paidBody });
  });

  test('a redelivery after payment replays the same body and pays nothing', async () => {
    const url = await startServer();

    const first = await post(url);
    const second = await post(url);

    expect(second.status).toBe(200);
    expect(second.text).toBe(first.text);
    expect(second.replayed).toBe('true');
    expect(mockedPayInvoice).toHaveBeenCalledTimes(1);
    expect(deps.recordRewardOutcome).toHaveBeenCalledTimes(1);
  });

  test('two simultaneous identical requests pay once', async () => {
    mockedPayInvoice.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      return { payment_hash: 'hash-1' };
    });
    const url = await startServer();

    const responses = await Promise.all([post(url), post(url)]);

    expect(responses.map(response => response.status).sort()).toEqual([
      200, 409,
    ]);
    const conflict = responses.find(response => response.status === 409);
    expect(JSON.parse(conflict?.text ?? '{}')).toEqual({
      status: 'processing',
      error: 'reward is already being processed',
    });
    expect(mockedPayInvoice).toHaveBeenCalledTimes(1);
  });

  test('the same key for a different reward is a 409 and pays nothing', async () => {
    const url = await startServer();
    await post(url);

    const response = await post(url, {
      body: { ...validBody, repo: 'octo-org/other-repo' },
    });

    expect(response.status).toBe(409);
    expect(JSON.parse(response.text)).toEqual({
      error: 'Idempotency-Key was already used for a different reward',
    });
    expect(mockedPayInvoice).toHaveBeenCalledTimes(1);
  });

  test('a different key for an identical reward pays again', async () => {
    const url = await startServer();

    await post(url, { idempotencyKey: 'delivery-1' });
    const second = await post(url, { idempotencyKey: 'delivery-2' });

    expect(second.status).toBe(200);
    expect(second.replayed).toBeNull();
    expect(mockedPayInvoice).toHaveBeenCalledTimes(2);
  });

  test('a repo that is not connected releases the key so a retry can pay', async () => {
    deps.assertRepoConnected.mockRejectedValueOnce(
      new RewardError("repo 'octo-org/octo-repo' is not connected", 403),
    );
    const url = await startServer();

    const rejected = await post(url);
    const retried = await post(url);

    expect(rejected.status).toBe(403);
    expect(JSON.parse(rejected.text)).toEqual({
      error: "repo 'octo-org/octo-repo' is not connected",
    });
    expect(retried.status).toBe(200);
    expect(mockedPayInvoice).toHaveBeenCalledTimes(1);
  });

  test('a failure before payInvoice releases the key so a retry can pay', async () => {
    mockedCreateInvoice.mockResolvedValueOnce(new Error('LNbits down'));
    const url = await startServer();

    const failed = await post(url);
    const retried = await post(url);

    expect(failed.status).toBe(500);
    expect(JSON.parse(failed.text)).toEqual({ error: 'internal error' });
    expect(deps.recordRewardOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
    expect(retried.status).toBe(200);
    expect(mockedPayInvoice).toHaveBeenCalledTimes(1);
  });

  test('a payInvoice that throws is uncertain and never paid again', async () => {
    mockedPayInvoice.mockRejectedValueOnce(new Error('socket hang up'));
    const url = await startServer();

    const failed = await post(url);
    const redelivered = await post(url);

    expect(failed.status).toBe(500);
    expect(JSON.parse(failed.text)).toEqual({
      error: 'payment outcome unknown',
    });
    expect(deps.recordRewardOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'needs-checking', sats: 21 }),
    );
    expect(redelivered.status).toBe(409);
    expect(JSON.parse(redelivered.text)).toEqual({
      status: 'uncertain',
      error: 'payment outcome unknown; needs reconciliation',
    });
    expect(mockedPayInvoice).toHaveBeenCalledTimes(1);
  });

  test('a payInvoice with no payment hash is uncertain too', async () => {
    mockedPayInvoice.mockResolvedValueOnce({});
    const url = await startServer();

    const failed = await post(url);
    const redelivered = await post(url);

    expect(failed.status).toBe(500);
    expect(redelivered.status).toBe(409);
    expect(mockedPayInvoice).toHaveBeenCalledTimes(1);
  });

  test('a pending reward returns 202 and replays 202 without queueing twice', async () => {
    mockedResolveRecipient.mockResolvedValue(null);
    const url = await startServer();

    const first = await post(url);
    const second = await post(url);

    expect(first.status).toBe(202);
    expect(JSON.parse(first.text)).toEqual({
      status: 'pending',
      recipient: 'octocat',
      amountSats: 21,
    });
    expect(second.status).toBe(202);
    expect(second.text).toBe(first.text);
    expect(second.replayed).toBe('true');
    expect(mockedCreatePendingReward).toHaveBeenCalledTimes(1);
    expect(mockedPayInvoice).not.toHaveBeenCalled();
  });

  test('a pending write with an unknown outcome is held and never queued again', async () => {
    // The portal may have stored it before the connection dropped.
    mockedResolveRecipient.mockResolvedValue(null);
    mockedCreatePendingReward.mockRejectedValueOnce(
      new PendingRewardWriteUncertainError('socket hang up'),
    );
    const url = await startServer();

    const failed = await post(url);
    const retried = await post(url);

    expect(failed.status).toBe(500);
    expect(JSON.parse(failed.text)).toEqual({
      error: 'payment outcome unknown',
    });
    expect(retried.status).toBe(409);
    expect(JSON.parse(retried.text)).toMatchObject({ status: 'uncertain' });
    expect(mockedCreatePendingReward).toHaveBeenCalledTimes(1);
    await expect(ledger.get(rewardKey('delivery-1'))).resolves.toMatchObject({
      state: 'uncertain',
    });
  });

  test('a pending write the portal rejected releases the key so a retry queues it', async () => {
    mockedResolveRecipient.mockResolvedValue(null);
    mockedCreatePendingReward.mockRejectedValueOnce(
      new Error('pending reward write failed: 401'),
    );
    const url = await startServer();

    const failed = await post(url);
    const retried = await post(url);

    expect(failed.status).toBe(500);
    expect(JSON.parse(failed.text)).toEqual({ error: 'internal error' });
    expect(retried.status).toBe(202);
    expect(mockedCreatePendingReward).toHaveBeenCalledTimes(2);
  });

  test('a paid reward is still replayed after a restart', async () => {
    const before = await startServer();
    const first = await post(before);

    ledger = new RewardLedger({ storePath });
    const after = await startServer();
    const second = await post(after);

    expect(second.status).toBe(200);
    expect(second.text).toBe(first.text);
    expect(mockedPayInvoice).toHaveBeenCalledTimes(1);
  });

  test('a paid reward the ledger fails to record still blocks redelivery', async () => {
    jest
      .spyOn(ledger, 'markPaid')
      .mockRejectedValueOnce(new Error('disk full'));
    const url = await startServer();

    const first = await post(url);
    const redelivered = await post(url);

    expect(first.status).toBe(200);
    expect(JSON.parse(first.text)).toEqual(paidBody);
    expect(redelivered.status).toBe(409);
    expect(JSON.parse(redelivered.text)).toMatchObject({
      status: 'processing',
    });
    expect(mockedPayInvoice).toHaveBeenCalledTimes(1);
  });

  test('an unavailable ledger is a 503 and pays nothing', async () => {
    jest
      .spyOn(ledger, 'reserve')
      .mockRejectedValueOnce(new Error('lock timed out'));
    const url = await startServer();

    const response = await post(url);

    expect(response.status).toBe(503);
    expect(JSON.parse(response.text)).toEqual({
      error: 'rewards endpoint unavailable',
    });
    expect(mockedPayInvoice).not.toHaveBeenCalled();
  });

  test('a key check that throws a RewardError keeps its status', async () => {
    deps.isAuthorizedRewardKey.mockRejectedValueOnce(
      new RewardError('rewards endpoint disabled: no API keys configured', 503),
    );
    const url = await startServer();

    const response = await post(url);

    expect(response.status).toBe(503);
    expect(JSON.parse(response.text)).toEqual({
      error: 'rewards endpoint disabled: no API keys configured',
    });
  });
});

describe('isAuthorizedRewardKey', () => {
  const savedEnvKey = process.env.REWARDS_API_KEY;
  const mockedGetHashes = getWebhookKeyHashes as unknown as jest.Mock<
    () => Promise<string[]>
  >;
  const sha256 = (value: string): string =>
    createHash('sha256').update(value).digest('hex');

  afterEach(() => {
    if (savedEnvKey === undefined) {
      delete process.env.REWARDS_API_KEY;
    } else {
      process.env.REWARDS_API_KEY = savedEnvKey;
    }
  });

  test('accepts the env key without reading portal keys', async () => {
    process.env.REWARDS_API_KEY = 'env-key';

    await expect(isAuthorizedRewardKey('env-key')).resolves.toBe(true);
    expect(mockedGetHashes).not.toHaveBeenCalled();
  });

  test('accepts an active portal-managed key by its hash', async () => {
    process.env.REWARDS_API_KEY = 'env-key';
    mockedGetHashes.mockResolvedValue([sha256('portal-key')]);

    await expect(isAuthorizedRewardKey('portal-key')).resolves.toBe(true);
    await expect(isAuthorizedRewardKey('env-kez')).resolves.toBe(false);
  });

  test('is disabled with a 503 when no key is configured anywhere', async () => {
    delete process.env.REWARDS_API_KEY;
    mockedGetHashes.mockResolvedValue([]);

    await expect(isAuthorizedRewardKey('anything')).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  test('an unexpected key-store failure is a 503 from the route', async () => {
    deps.isAuthorizedRewardKey.mockRejectedValueOnce(new Error('timeout'));
    const url = await startServer();

    const response = await post(url);

    expect(response.status).toBe(503);
    expect(JSON.parse(response.text)).toEqual({
      error: 'rewards endpoint unavailable',
    });
  });
});
