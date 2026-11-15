import express from 'express';
import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { createHmac } from 'crypto';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import {
  createGithubWebhookRouter,
  GithubWebhookRouteDeps,
} from './githubWebhookRoute';
import { createRewardsRouter, RewardsRouteDeps } from './rewardsRoute';
import { RewardLedger, rewardKey } from './services/rewardLedger';
import { RewardBudgetLedger } from './services/rewardBudget';
import {
  RewardAmount,
  RewardError,
  resolveAmountSats,
} from './services/rewardsService';
import { getRewardConfig, RewardBudget } from './services/fetchRewardPolicy';
import { payReward as payRewardThroughPortal } from './services/peopleDirectory';
import { resolveRewardRecipientByGithubId } from './services/identityService';
import { createPendingReward } from './services/pendingRewardsService';

// The real processReward and payReward run; only LNbits and the portal are
// stubbed, so "payInvoice was called once" means the treasury paid once.
jest.mock('./services/peopleDirectory', () => ({
  ...jest.requireActual<typeof import('./services/peopleDirectory')>(
    './services/peopleDirectory',
  ),
  payReward: jest.fn(),
}));
jest.mock('./services/identityService', () => ({
  resolveRewardRecipientByGithubId: jest.fn(),
}));
jest.mock('./services/fetchRewardPolicy', () => ({
  getRewardConfig: jest.fn(),
}));
jest.mock('./services/pendingRewardsService', () => ({
  ...jest.requireActual<object>('./services/pendingRewardsService'),
  createPendingReward: jest.fn(),
}));

type AsyncMock = jest.Mock<(...args: unknown[]) => Promise<unknown>>;
// The portal's pay-reward call: "called once" means the treasury paid once.
const mockedPayInvoice = payRewardThroughPortal as unknown as AsyncMock;
const mockedResolveRecipient =
  resolveRewardRecipientByGithubId as unknown as AsyncMock;
const mockedCreatePendingReward = createPendingReward as unknown as AsyncMock;
const mockedGetRewardConfig = getRewardConfig as unknown as AsyncMock;

const SECRET = 'test-webhook-secret';
const NOW = Date.parse('2026-10-28T12:00:00Z');
const mergedEvent = {
  action: 'closed',
  number: 7,
  pull_request: {
    id: 2001,
    number: 7,
    title: 'Add the thing',
    merged: true,
    merged_at: '2026-10-28T11:59:00Z',
    user: { login: 'octocat', id: 583231, type: 'User' },
    merged_by: { login: 'reviewer', id: 9001, type: 'User' },
    labels: [{ name: 'bug' }, { name: 'reward:L2' }],
  },
  repository: { full_name: 'octo-org/octo-repo' },
};
const PR_KEY = 'github:pull_request:2001:merged';

const AMOUNT_21: RewardAmount = {
  amountSats: 21,
  baseSats: 21,
  bonusSats: 0,
  level: null,
};

const tempDirectories: string[] = [];
const servers: http.Server[] = [];
let storePath: string;
let ledger: RewardLedger;
let budgetLedger: RewardBudgetLedger;
let deps: {
  assertRepoConnected: jest.Mock<(repo: string) => Promise<void>>;
  resolveAmountSats: jest.Mock<() => Promise<RewardAmount>>;
  recordRewardOutcome: jest.Mock<(outcome: unknown) => void>;
  getRewardBudget: jest.Mock<() => Promise<RewardBudget>>;
};
let secret: string | undefined;
const savedTreasuryKey = process.env.REWARDS_TREASURY_ADMINKEY;

const startServer = async (
  overrides: Partial<GithubWebhookRouteDeps> = {},
): Promise<string> => {
  const app = express();
  // The real server mounts this route before express.json(); doing the same
  // here proves the raw body survives.
  app.use(
    createGithubWebhookRouter({
      ledger,
      budgetLedger,
      webhookSecret: () => secret,
      now: () => NOW,
      ...(deps as unknown as Partial<GithubWebhookRouteDeps>),
      ...overrides,
    }),
  );
  app.use(express.json());
  const server = await new Promise<http.Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/api/v1/github/webhook`;
};

const sign = (body: string, key = SECRET): string =>
  `sha256=${createHmac('sha256', key).update(body).digest('hex')}`;

interface DeliverOptions {
  event?: string;
  body?: unknown;
  rawBody?: string;
  signature?: string | null;
  delivery?: string;
  contentType?: string;
}

const deliver = async (
  url: string,
  {
    event = 'pull_request',
    body = mergedEvent,
    rawBody,
    signature,
    delivery = 'delivery-1',
    contentType = 'application/json',
  }: DeliverOptions = {},
) => {
  const payload = rawBody ?? JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': contentType,
    'x-github-event': event,
    'x-github-delivery': delivery,
  };
  const signed = signature === undefined ? sign(payload) : signature;
  if (signed !== null) {
    headers['x-hub-signature-256'] = signed;
  }
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: payload,
  });
  return {
    status: response.status,
    text: await response.text(),
    replayed: response.headers.get('idempotency-replayed'),
  };
};

beforeEach(() => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-webhook-'));
  tempDirectories.push(directory);
  storePath = path.join(directory, 'bot-reward-ledger.json');
  ledger = new RewardLedger({ storePath, lockRetryMs: 1 });
  budgetLedger = new RewardBudgetLedger({
    storePath: path.join(directory, 'bot-reward-budget.json'),
    lockRetryMs: 1,
  });
  secret = SECRET;
  deps = {
    assertRepoConnected: jest.fn(async () => undefined),
    resolveAmountSats: jest.fn(async () => AMOUNT_21),
    recordRewardOutcome: jest.fn(),
    // A budget far above anything these tests pay; the budget suite tests
    // the cap itself.
    getRewardBudget: jest.fn(async () => ({
      period: 'week' as const,
      capSats: 1_000_000,
      timezone: 'Europe/London',
    })),
  };
  process.env.REWARDS_TREASURY_ADMINKEY = 'treasury-admin-key';
  mockedResolveRecipient.mockResolvedValue({ personAad: 'oid-1' });
  mockedPayInvoice.mockResolvedValue('hash-1');
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

describe('POST /api/v1/github/webhook: authentication', () => {
  test('no secret configured is a 503 and touches nothing', async () => {
    secret = undefined;
    const reserve = jest.spyOn(ledger, 'reserve');
    const url = await startServer();

    const response = await deliver(url);

    expect(response.status).toBe(503);
    expect(JSON.parse(response.text)).toEqual({
      error: 'GitHub webhook disabled: no secret configured',
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(fs.existsSync(storePath)).toBe(false);
    expect(mockedPayInvoice).not.toHaveBeenCalled();
  });

  test.each([
    ['missing', null],
    ['signed with another secret', sign(JSON.stringify(mergedEvent), 'nope')],
    ['malformed', 'sha256=zz'],
  ])('a %s signature is a 401 and reserves nothing', async (_l, signature) => {
    const reserve = jest.spyOn(ledger, 'reserve');
    const url = await startServer();

    const response = await deliver(url, { signature });

    expect(response.status).toBe(401);
    expect(JSON.parse(response.text)).toEqual({ error: 'invalid signature' });
    expect(reserve).not.toHaveBeenCalled();
    expect(fs.existsSync(storePath)).toBe(false);
    expect(mockedPayInvoice).not.toHaveBeenCalled();
  });

  test('a body altered after signing is a 401', async () => {
    const url = await startServer();
    const original = JSON.stringify(mergedEvent);
    const altered = JSON.stringify({
      ...mergedEvent,
      pull_request: {
        ...mergedEvent.pull_request,
        user: { login: 'mallory', id: 1 },
      },
    });

    const response = await deliver(url, {
      rawBody: altered,
      signature: sign(original),
    });

    expect(response.status).toBe(401);
    expect(mockedPayInvoice).not.toHaveBeenCalled();
  });

  test('a non-JSON content type is a 415', async () => {
    const url = await startServer();

    const response = await deliver(url, {
      contentType: 'application/x-www-form-urlencoded',
    });

    expect(response.status).toBe(415);
    expect(mockedPayInvoice).not.toHaveBeenCalled();
  });

  test('a body over 1 MB is a 413 and reserves nothing', async () => {
    const reserve = jest.spyOn(ledger, 'reserve');
    const url = await startServer();
    const rawBody = JSON.stringify({
      ...mergedEvent,
      padding: 'x'.repeat(1024 * 1024 + 1),
    });

    const response = await deliver(url, { rawBody });

    expect(response.status).toBe(413);
    expect(JSON.parse(response.text)).toEqual({ error: 'payload too large' });
    expect(reserve).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/github/webhook: events', () => {
  test('ping is a 204 and reserves nothing', async () => {
    const url = await startServer();

    const response = await deliver(url, {
      event: 'ping',
      body: { zen: 'Keep it simple.' },
    });

    expect(response.status).toBe(204);
    expect(fs.existsSync(storePath)).toBe(false);
  });

  test.each([
    ['opened', { ...mergedEvent, action: 'opened' }],
    [
      'closed without merge',
      {
        ...mergedEvent,
        pull_request: { ...mergedEvent.pull_request, merged: false },
      },
    ],
  ])('a PR %s is a 204 and pays nothing', async (_label, body) => {
    const url = await startServer();

    const response = await deliver(url, { body });

    expect(response.status).toBe(204);
    expect(fs.existsSync(storePath)).toBe(false);
    expect(mockedPayInvoice).not.toHaveBeenCalled();
  });

  test('a signed body that is not JSON is a 400', async () => {
    const url = await startServer();

    const response = await deliver(url, { rawBody: 'not json' });

    expect(response.status).toBe(400);
  });

  test('a merge older than the replay window is a 422 and pays nothing', async () => {
    const url = await startServer();

    const response = await deliver(url, {
      body: {
        ...mergedEvent,
        pull_request: {
          ...mergedEvent.pull_request,
          merged_at: '2026-01-01T00:00:00Z',
        },
      },
    });

    expect(response.status).toBe(422);
    expect(fs.existsSync(storePath)).toBe(false);
  });

  test('a merged PR pays exactly once and records it as paid', async () => {
    const url = await startServer();

    const response = await deliver(url);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toEqual({
      status: 'paid',
      paymentHash: 'hash-1',
      recipient: 'octocat',
      amountSats: 21,
    });
    expect(deps.assertRepoConnected).toHaveBeenCalledWith('octo-org/octo-repo');
    expect(mockedPayInvoice).toHaveBeenCalledTimes(1);
    expect(mockedResolveRecipient).toHaveBeenCalledWith('583231');
    await expect(
      new RewardLedger({ storePath }).get(rewardKey(PR_KEY)),
    ).resolves.toMatchObject({ state: 'paid' });
  });

  test('a redelivery of the same delivery replays and pays once', async () => {
    const url = await startServer();

    const first = await deliver(url);
    const second = await deliver(url);

    expect(second.status).toBe(200);
    expect(second.text).toBe(first.text);
    expect(second.replayed).toBe('true');
    expect(mockedPayInvoice).toHaveBeenCalledTimes(1);
  });

  test('a captured request resent under a new delivery id still replays', async () => {
    // X-GitHub-Delivery is not signed, so it cannot be the idempotency key.
    const url = await startServer();

    await deliver(url, { delivery: 'delivery-1' });
    const replayed = await deliver(url, { delivery: 'delivery-forged' });

    expect(replayed.status).toBe(200);
    expect(replayed.replayed).toBe('true');
    expect(mockedPayInvoice).toHaveBeenCalledTimes(1);
  });

  test('the legacy Logic App posting the same merge replays and pays once', async () => {
    // Both paths share one ledger and one key per merged PR
    // (docs/automation/github-rewards-logicapp.json), so a merge paid by the
    // webhook is never paid again by the Logic App, or the other way round.
    const app = express();
    app.use(
      createGithubWebhookRouter({
        ledger,
        budgetLedger,
        webhookSecret: () => secret,
        now: () => NOW,
        ...(deps as unknown as Partial<GithubWebhookRouteDeps>),
      }),
    );
    app.use(express.json());
    app.use(
      createRewardsRouter({
        ledger,
        budgetLedger,
        isAuthorizedRewardKey: async key => key === 'automation-key',
        ...(deps as unknown as Partial<RewardsRouteDeps>),
      }),
    );
    const server = await new Promise<http.Server>(resolve => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const paid = await deliver(`${base}/api/v1/github/webhook`);
    expect(paid.status).toBe(200);

    // The body and key the Logic App template builds from the same event.
    const pullRequest = mergedEvent.pull_request;
    const legacy = await fetch(`${base}/api/v1/rewards`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'automation-key',
        'idempotency-key': `github:pull_request:${pullRequest.id}:merged`,
      },
      body: JSON.stringify({
        recipient: pullRequest.user.login,
        recipientId: pullRequest.user.id,
        eventType: 'githubPrMerged',
        repo: mergedEvent.repository.full_name,
        reason: `GitHub: PR #${mergedEvent.number} merged - ${pullRequest.title}`,
        source: 'github',
      }),
    });

    expect(legacy.status).toBe(200);
    expect(legacy.headers.get('idempotency-replayed')).toBe('true');
    expect(await legacy.text()).toBe(paid.text);
    expect(mockedPayInvoice).toHaveBeenCalledTimes(1);
  });

  test('a repo that is not connected is a 403 and the key is released', async () => {
    deps.assertRepoConnected.mockRejectedValueOnce(
      new RewardError("repo 'octo-org/octo-repo' is not connected", 403),
    );
    const url = await startServer();

    const rejected = await deliver(url);

    expect(rejected.status).toBe(403);
    expect(mockedPayInvoice).not.toHaveBeenCalled();
    await expect(ledger.get(rewardKey(PR_KEY))).resolves.toBeUndefined();
  });

  test('an unconfigured amount pays nothing and releases the key', async () => {
    deps.resolveAmountSats.mockRejectedValueOnce(
      new RewardError(
        "no configured amount for eventType 'githubPrMerged'",
        503,
      ),
    );
    const url = await startServer();

    const response = await deliver(url);

    expect(response.status).toBe(503);
    expect(mockedPayInvoice).not.toHaveBeenCalled();
    await expect(ledger.get(rewardKey(PR_KEY))).resolves.toBeUndefined();
  });

  test('a merged PR by an unlinked author is queued as pending', async () => {
    mockedResolveRecipient.mockResolvedValue(null);
    const reserve = jest.spyOn(budgetLedger, 'reserve');
    const url = await startServer();

    const response = await deliver(url);

    expect(response.status).toBe(202);
    expect(mockedCreatePendingReward).toHaveBeenCalledTimes(1);
    expect(reserve).not.toHaveBeenCalled();
    expect(mockedPayInvoice).not.toHaveBeenCalled();
  });

  test.each([
    [
      'merged by its own author',
      { merged_by: { login: 'octocat', id: 583231, type: 'User' } },
      'author merged their own pull request',
    ],
    [
      'authored by Dependabot',
      { user: { login: 'dependabot[bot]', id: 49699333, type: 'Bot' } },
      'author is a bot',
    ],
  ])(
    'a PR %s is a 200 not-rewarded, reserves nothing and queues nothing',
    async (_label, change, reason) => {
      const reserve = jest.spyOn(budgetLedger, 'reserve');
      const url = await startServer();

      const response = await deliver(url, {
        body: {
          ...mergedEvent,
          pull_request: { ...mergedEvent.pull_request, ...change },
        },
      });

      expect(response.status).toBe(200);
      expect(JSON.parse(response.text)).toEqual({
        status: 'not-rewarded',
        reason,
      });
      expect(fs.existsSync(storePath)).toBe(false);
      expect(reserve).not.toHaveBeenCalled();
      expect(mockedCreatePendingReward).not.toHaveBeenCalled();
      expect(mockedPayInvoice).not.toHaveBeenCalled();
    },
  );

  test.each([
    ['null', null],
    ['with a zero id', { login: 'reviewer', id: 0 }],
  ])(
    'a signed merge with merged_by %s is a 400 and pays nothing',
    async (_label, mergedBy) => {
      const url = await startServer();

      const response = await deliver(url, {
        body: {
          ...mergedEvent,
          pull_request: { ...mergedEvent.pull_request, merged_by: mergedBy },
        },
      });

      expect(response.status).toBe(400);
      expect(fs.existsSync(storePath)).toBe(false);
      expect(mockedPayInvoice).not.toHaveBeenCalled();
    },
  );

  test('an uncertain payment is never retried by a redelivery', async () => {
    mockedPayInvoice.mockRejectedValueOnce(new Error('socket hang up'));
    const url = await startServer();

    const failed = await deliver(url);
    const redelivered = await deliver(url);

    expect(failed.status).toBe(500);
    expect(redelivered.status).toBe(409);
    expect(JSON.parse(redelivered.text)).toMatchObject({
      status: 'uncertain',
    });
    expect(mockedPayInvoice).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/v1/github/webhook: reward policy', () => {
  const OID = '11111111-2222-3333-4444-555555555555';

  beforeEach(() => {
    mockedResolveRecipient.mockResolvedValue({ personAad: OID });
  });

  test('the PR labels and the resolved recipient reach the amount', async () => {
    const url = await startServer();

    await deliver(url);

    expect(deps.resolveAmountSats).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['bug', 'reward:L2'] }),
      { personAad: OID },
    );
  });

  test('a person override plus the label bonus is what the invoice charges', async () => {
    mockedGetRewardConfig.mockResolvedValue({
      rewardAmounts: { githubPrMergedSats: 1000 },
      rewardPolicy: {
        version: 1,
        levels: {
          githubPrMerged: {
            labelPrefix: 'reward:',
            bonuses: { L1: 250, L2: 500 },
          },
        },
        overrides: { [OID]: { githubPrMerged: { baseSats: 1500 } } },
        budget: null,
      },
    });
    const url = await startServer({ resolveAmountSats });

    const response = await deliver(url);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toMatchObject({ amountSats: 2000 });
    expect(mockedPayInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientOid: OID,
        amountSats: 2000,
        memo: 'GitHub: PR #7 merged - Add the thing',
        reward: expect.objectContaining({
          baseSats: 1500,
          bonusSats: 500,
          level: 'L2',
        }),
      }),
    );
  });

  test('nothing configured in the portal pays nothing', async () => {
    mockedGetRewardConfig.mockResolvedValue({
      rewardAmounts: {},
      rewardPolicy: { version: 1, levels: {}, overrides: {}, budget: null },
    });
    const url = await startServer({ resolveAmountSats });

    const response = await deliver(url);

    expect(response.status).toBe(503);
    expect(mockedPayInvoice).not.toHaveBeenCalled();
    await expect(ledger.get(rewardKey(PR_KEY))).resolves.toBeUndefined();
  });

  test('a relabel after merge replays the first result and never pays twice', async () => {
    const url = await startServer();
    const first = await deliver(url);

    const relabelled = await deliver(url, {
      body: {
        ...mergedEvent,
        pull_request: {
          ...mergedEvent.pull_request,
          labels: [{ name: 'reward:L3' }],
        },
      },
    });

    expect(relabelled.status).toBe(200);
    expect(relabelled.replayed).toBe('true');
    expect(relabelled.text).toBe(first.text);
    expect(mockedPayInvoice).toHaveBeenCalledTimes(1);
  });

  test('a recipient lookup failure pays nothing and releases the key', async () => {
    mockedResolveRecipient.mockRejectedValueOnce(
      new Error('identity resolve failed: 502'),
    );
    const url = await startServer();

    const failed = await deliver(url);
    const retried = await deliver(url);

    expect(failed.status).toBe(500);
    expect(deps.resolveAmountSats).toHaveBeenCalledTimes(1);
    expect(retried.status).toBe(200);
    expect(mockedPayInvoice).toHaveBeenCalledTimes(1);
  });
});
