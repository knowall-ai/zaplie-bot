// LNBITS_INITIAL_ALLOWANCE is the opening grant for every new Allowance
// wallet, paid through the LNbits admin top-up (which creates sats). It must
// be a plain whole number: parseInt read '1e3' as 1 and '25,000' as 25, so a
// typo paid the wrong amount to every new joiner. A malformed value stops the
// bot when UserService is constructed at startup; unset or blank means no
// grant.
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import type { TeamsChannelAccount } from 'botbuilder';

jest.mock('./lnbitsService');

type UserServiceModule = {
  UserService: {
    getInstance(): {
      ensureUserSetup(account: TeamsChannelAccount): Promise<unknown>;
    };
  };
  resolveInitialAllowance?: () => number | null;
};
type LnbitsMock = Record<
  | 'getUsers'
  | 'createUser'
  | 'createWallet'
  | 'getUserWallets'
  | 'getWalletById'
  | 'topUpWallet',
  jest.Mock<(...args: unknown[]) => Promise<unknown>>
>;

const ENV = 'LNBITS_INITIAL_ALLOWANCE';
const original = process.env[ENV];

const setAllowance = (value: string | undefined) => {
  if (value === undefined) {
    delete process.env[ENV];
  } else {
    process.env[ENV] = value;
  }
};

// UserService is a singleton, so each case loads a fresh copy of the module
// (and of the mocked lnbitsService it calls) under its own env value.
const load = (value: string | undefined) => {
  setAllowance(value);
  let mod!: UserServiceModule;
  let lnbits!: LnbitsMock;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    lnbits = require('./lnbitsService') as LnbitsMock;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('./userService') as UserServiceModule;
  });
  lnbits.getUsers.mockResolvedValue([]);
  lnbits.createUser.mockResolvedValue({ id: 'u1', displayName: 'New Joiner' });
  lnbits.createWallet
    .mockResolvedValueOnce({ id: 'w-allowance', name: 'Allowance' })
    .mockResolvedValueOnce({ id: 'w-private', name: 'Private' });
  lnbits.getUserWallets.mockResolvedValue([]);
  // The wallets just created are found again by id, as LNbits would.
  lnbits.getWalletById.mockImplementation(async (_userId, walletId) => ({
    id: walletId,
  }));
  lnbits.topUpWallet.mockResolvedValue(undefined);
  return { mod, lnbits };
};

const newJoiner = {
  id: '29:new',
  name: 'New Joiner',
  aadObjectId: 'aad-new',
  userPrincipalName: 'new@example.com',
} as unknown as TeamsChannelAccount;

// Construct the service the way src/index.ts does at startup, then (if that
// succeeded) set up a brand-new user.
const startAndProvision = async (value: string | undefined) => {
  const { mod, lnbits } = load(value);
  let startupError: Error | undefined;
  try {
    const service = mod.UserService.getInstance();
    await service.ensureUserSetup(newJoiner);
  } catch (error) {
    startupError = error as Error;
  }
  return { lnbits, startupError };
};

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
  setAllowance(original);
});

describe('resolveInitialAllowance', () => {
  test.each([
    ['unset', undefined],
    ['empty', ''],
    ['blank', '   '],
  ])('%s means no grant', (_label, value) => {
    const { mod } = load(value);
    expect(mod.resolveInitialAllowance?.()).toBeNull();
  });

  test.each([
    ['15000', 15000],
    [' 15000 ', 15000],
  ])('%p is %p sats', (value, expected) => {
    const { mod } = load(value);
    expect(mod.resolveInitialAllowance?.()).toBe(expected);
  });

  test.each([
    '1e3',
    '25,000',
    '+1',
    '0x10',
    '-5',
    '0',
    '1.5',
    '15000abc',
    'abc',
    '9007199254740993',
  ])('%p is refused naming the setting', value => {
    const { mod } = load(value);
    expect(typeof mod.resolveInitialAllowance).toBe('function');
    expect(() => mod.resolveInitialAllowance?.()).toThrow(
      /LNBITS_INITIAL_ALLOWANCE must be a positive integer/,
    );
  });
});

describe('UserService grants the configured allowance to a new user', () => {
  test('15000 tops up the new Allowance wallet with exactly 15000 sats', async () => {
    const { lnbits, startupError } = await startAndProvision('15000');
    expect(startupError).toBeUndefined();
    expect(lnbits.topUpWallet).toHaveBeenCalledTimes(1);
    expect(lnbits.topUpWallet).toHaveBeenCalledWith('w-allowance', 15000);
  });

  test.each([
    ['unset', undefined],
    ['blank', '   '],
  ])('%s creates the user with no top-up', async (_label, value) => {
    const { lnbits, startupError } = await startAndProvision(value);
    expect(startupError).toBeUndefined();
    expect(lnbits.createUser).toHaveBeenCalledTimes(1);
    expect(lnbits.createWallet.mock.calls[0]?.[2]).toBe('Allowance');
    expect(lnbits.topUpWallet).not.toHaveBeenCalled();
  });

  test.each(['1e3', '25,000', '+1', '0x10', '-5', '0'])(
    '%p stops the service at startup and creates or funds nothing',
    async value => {
      const { lnbits, startupError } = await startAndProvision(value);
      expect(lnbits.topUpWallet).not.toHaveBeenCalled();
      expect(lnbits.createUser).not.toHaveBeenCalled();
      expect(lnbits.createWallet).not.toHaveBeenCalled();
      expect(startupError?.message).toMatch(
        /LNBITS_INITIAL_ALLOWANCE must be a positive integer/,
      );
    },
  );
});
