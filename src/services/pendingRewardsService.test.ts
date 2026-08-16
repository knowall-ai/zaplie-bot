import { afterAll, beforeEach, expect, jest, test } from '@jest/globals';
import { createPendingReward, PendingReward } from './pendingRewardsService';

const originalFetch = global.fetch;
const originalToken = process.env.TAB_BACKEND_TOKEN;
const originalApiUrl = process.env.WEBSITE_API_URL;
const fetchMock = jest.fn<typeof fetch>();

const pendingReward: PendingReward = {
  provider: 'github',
  providerId: '583231',
  recipientLabel: 'octocat',
  amountSats: 210,
  reason: 'GitHub: PR #7 merged',
  source: 'github',
};

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock;
  process.env.TAB_BACKEND_TOKEN = 'test-internal-token';
  process.env.WEBSITE_API_URL = 'https://portal.example.test/api/';
});

afterAll(() => {
  global.fetch = originalFetch;
  if (originalToken === undefined) {
    delete process.env.TAB_BACKEND_TOKEN;
  } else {
    process.env.TAB_BACKEND_TOKEN = originalToken;
  }
  if (originalApiUrl === undefined) {
    delete process.env.WEBSITE_API_URL;
  } else {
    process.env.WEBSITE_API_URL = originalApiUrl;
  }
});

test('posts pending rewards with the server-only shared token', async () => {
  fetchMock.mockResolvedValue({ ok: true, status: 201 } as Response);

  await createPendingReward(pendingReward);

  expect(fetchMock).toHaveBeenCalledWith(
    'https://portal.example.test/api/pending-rewards',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'test-internal-token',
      },
      body: JSON.stringify(pendingReward),
    },
  );
});

test('fails before the request when TAB_BACKEND_TOKEN is missing', async () => {
  delete process.env.TAB_BACKEND_TOKEN;

  await expect(createPendingReward(pendingReward)).rejects.toThrow(
    'TAB_BACKEND_TOKEN',
  );
  expect(fetchMock).not.toHaveBeenCalled();
});
