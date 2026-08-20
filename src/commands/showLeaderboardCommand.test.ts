// showLeaderboardCommand.test.ts
//
// Mocks lnbitsService (external dependency), not the command itself.

import { ShowLeaderboardCommand } from './showLeaderboardCommand';
import { getWallets, getUser } from '../services/lnbitsService';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import { TurnContext } from 'botbuilder';

jest.mock('../services/lnbitsService');

const mockGetWallets = getWallets as jest.MockedFunction<typeof getWallets>;
const mockGetUser = getUser as jest.MockedFunction<typeof getUser>;

const wallet = (overrides: Partial<Wallet>): Wallet => ({
  id: 'w1',
  admin: 'admin',
  name: 'Private',
  user: 'user-1',
  adminkey: 'adminkey',
  inkey: 'inkey',
  balance_msat: 1_000_000,
  deleted: false,
  ...overrides,
});

const user = (overrides: Partial<User>): User => ({
  id: 'user-1',
  displayName: 'Alice',
  profileImg: '',
  aadObjectId: 'aad-alice',
  email: 'alice@example.com',
  privateWallet: null,
  allowanceWallet: null,
  ...overrides,
});

const makeContext = () => {
  const sendActivity = jest
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined);
  const context = { sendActivity } as unknown as TurnContext;
  return { context, sendActivity };
};

const sentCard = (sendActivity: jest.Mock): any => {
  const [activity] = sendActivity.mock.calls[0] as [any];
  return activity.attachments[0].content;
};

describe('showLeaderboardCommand', () => {
  const originalPortalUrl = process.env.PORTAL_URL;

  beforeEach(() => {
    mockGetWallets.mockResolvedValue([
      wallet({ id: 'w1', user: 'user-1', balance_msat: 2_000_000 }),
    ]);
    mockGetUser.mockResolvedValue(user({ id: 'user-1' }));
  });

  afterEach(() => {
    jest.clearAllMocks();
    if (originalPortalUrl === undefined) {
      delete process.env.PORTAL_URL;
    } else {
      process.env.PORTAL_URL = originalPortalUrl;
    }
  });

  test('links the View Wallets button to the configured portal', async () => {
    process.env.PORTAL_URL = 'https://portal.example.test';
    const { context, sendActivity } = makeContext();

    await new ShowLeaderboardCommand().execute(context);

    const card = sentCard(sendActivity);
    expect(card.actions).toEqual([
      {
        type: 'Action.OpenUrl',
        title: 'View Wallets',
        url: 'https://portal.example.test/wallet',
      },
    ]);
  });

  test('drops a trailing slash from the configured portal URL', async () => {
    process.env.PORTAL_URL = 'https://portal.example.test/';
    const { context, sendActivity } = makeContext();

    await new ShowLeaderboardCommand().execute(context);

    expect(sentCard(sendActivity).actions[0].url).toBe(
      'https://portal.example.test/wallet',
    );
  });

  test('omits the button entirely when PORTAL_URL is not set', async () => {
    delete process.env.PORTAL_URL;
    const { context, sendActivity } = makeContext();

    await new ShowLeaderboardCommand().execute(context);

    expect(sentCard(sendActivity).actions).toBeUndefined();
  });
});
