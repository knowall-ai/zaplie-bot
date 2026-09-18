// showMyBalanceCommand.test.ts
//
// Mocks lnbitsService (the HTTP boundary), not the command. Pins that the
// balance reply is right and that no wallet key reaches the logs.

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
import { getUserWallets } from '../services/lnbitsService';

jest.mock('../services/lnbitsService');

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
  privateWallet: wallet('Private', 5000),
  allowanceWallet: wallet('Allowance', 21000),
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
      .mocked(getUserWallets)
      .mockResolvedValue([wallet('Allowance', 21000), wallet('Private', 5000)]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalPointsLabel === undefined) {
      delete process.env.LNBITS_POINTS_LABEL;
    } else {
      process.env.LNBITS_POINTS_LABEL = originalPointsLabel;
    }
  });

  test('replies with one balance line per wallet', async () => {
    const { context, sendActivity } = makeContext(user);

    await new ShowMyBalanceCommand().execute(context);

    expect(sendActivity).toHaveBeenCalledWith(
      'Your Allowance wallet has a balance of 21 Sats.',
    );
    expect(sendActivity).toHaveBeenCalledWith(
      'Your Private wallet has a balance of 5 Sats.',
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

  test('tells the user when no wallets exist', async () => {
    jest.mocked(getUserWallets).mockResolvedValue([]);
    const { context, sendActivity } = makeContext(user);

    await new ShowMyBalanceCommand().execute(context);

    expect(sendActivity).toHaveBeenCalledWith('No wallets found for the user.');
  });
});
