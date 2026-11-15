// showMyBalanceCommand.test.ts
//
// Mocks the people directory (the HTTP boundary), not the command. Pins that
// the balance reply is right and that no wallet key reaches the logs.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import { TurnContext } from 'botbuilder';
import { ShowMyBalanceCommand } from './showMyBalanceCommand';
import { getBalances } from '../services/peopleDirectory';

jest.mock('../services/peopleDirectory');

const wallet = (name: string, balanceMsat: number): Wallet => ({
  id: `w-${name.toLowerCase()}`,
  admin: '',
  name,
  user: 'user-1',
  adminkey: `${name.toLowerCase()}-adminkey-secret`,
  inkey: `${name.toLowerCase()}-inkey-secret`,
  balance_msat: balanceMsat,
  deleted: false,
});

const user: User = {
  id: 'user-1',
  displayName: 'Alice',
  profileImg: '',
  aadObjectId: 'aad-alice',
  email: 'alice@example.test',
  allowanceWallet: wallet('Allowance', 21000),
  canReceive: true,
};

const makeContext = (turnUser: User | undefined) => {
  const sendActivity = jest
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined);
  const turnState = new Map<unknown, unknown>();
  if (turnUser) {
    turnState.set('user', turnUser);
  }
  const context = { turnState, sendActivity } as unknown as TurnContext;
  return { context, sendActivity };
};

const originalPointsLabel = process.env.LNBITS_POINTS_LABEL;

describe('ShowMyBalanceCommand', () => {
  let consoleLog: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    process.env.LNBITS_POINTS_LABEL = 'Sats';
    consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest
      .mocked(getBalances)
      .mockResolvedValue({ allowanceSats: 21, budgetRemainingSats: null });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalPointsLabel === undefined) {
      delete process.env.LNBITS_POINTS_LABEL;
    } else {
      process.env.LNBITS_POINTS_LABEL = originalPointsLabel;
    }
  });

  test('replies with the Allowance balance and explains the Private wallet', async () => {
    const { context, sendActivity } = makeContext(user);

    await new ShowMyBalanceCommand().execute(context);

    expect(sendActivity).toHaveBeenCalledWith(
      'Your Allowance wallet has a balance of 21 Sats.',
    );
    expect(sendActivity).toHaveBeenCalledWith(
      expect.stringContaining('Zaps you receive go to your own Private wallet'),
    );
  });

  test('never writes a wallet key to the logs', async () => {
    const { context } = makeContext(user);

    await new ShowMyBalanceCommand().execute(context);

    const logged = JSON.stringify(consoleLog.mock.calls);
    expect(logged).not.toContain('adminkey');
    expect(logged).not.toContain('inkey');
    expect(logged).not.toContain('-secret');
  });

  test('a budget the wallet reports is shown; the Private wallet is never shown as 0', async () => {
    jest
      .mocked(getBalances)
      .mockResolvedValue({ allowanceSats: 21, budgetRemainingSats: 4 });
    const { context, sendActivity } = makeContext(user);

    await new ShowMyBalanceCommand().execute(context);

    expect(sendActivity).toHaveBeenCalledWith(
      'You can still send 4 Sats this period.',
    );
    expect(sendActivity).not.toHaveBeenCalledWith(
      'Your Private wallet has a balance of 0 Sats.',
    );
  });

  test('a person with no Allowance wallet yet is told to ask an admin', async () => {
    jest
      .mocked(getBalances)
      .mockResolvedValue({ allowanceSats: null, budgetRemainingSats: null });
    const { context, sendActivity } = makeContext({
      ...user,
      allowanceWallet: null,
    });

    await new ShowMyBalanceCommand().execute(context);

    expect(sendActivity).toHaveBeenCalledWith(
      expect.stringContaining('Allowance wallet has not been set up yet'),
    );
  });
});
