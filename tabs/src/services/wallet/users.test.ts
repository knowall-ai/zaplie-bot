import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const mockApiRequest = jest.fn<Promise<unknown>, [string, RequestInit?]>();

jest.mock('./gateway', () => ({
  apiRequest: (path: string, init?: RequestInit) => mockApiRequest(path, init),
}));

jest.mock('./wallets', () => ({
  getUserWallets: async () => [],
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { apiCache, clearApiCache } = require('./cache');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ensureCurrentUser, getUsers } = require('./users');

const OLD_DIRECTORY = [{ id: 'user-1', aadObjectId: 'oid-1' }];
const NEW_DIRECTORY = [
  ...OLD_DIRECTORY,
  { id: 'user-2', aadObjectId: 'oid-2' },
];

describe('the users directory after provisioning', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearApiCache();
  });

  test('a request still in flight when someone is created cannot restore the old directory', async () => {
    let settleOld: (value: unknown) => void = () => undefined;
    mockApiRequest.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          settleOld = resolve;
        }),
    );
    const before = getUsers();

    mockApiRequest.mockResolvedValueOnce({
      user: { id: 'user-2', aadObjectId: 'oid-2' },
      created: true,
      createdWallets: ['Allowance', 'Private'],
    });
    await ensureCurrentUser();

    settleOld(OLD_DIRECTORY);
    expect(await before).toEqual(OLD_DIRECTORY);
    expect(apiCache.users).toBeUndefined();

    mockApiRequest.mockResolvedValueOnce(NEW_DIRECTORY);
    expect(await getUsers()).toEqual(NEW_DIRECTORY);
    expect(mockApiRequest).toHaveBeenCalledTimes(3);
  });

  test('a directory fetched after provisioning is cached as usual', async () => {
    mockApiRequest.mockResolvedValueOnce({
      user: { id: 'user-1' },
      created: false,
      createdWallets: [],
    });
    await ensureCurrentUser();

    mockApiRequest.mockResolvedValueOnce(NEW_DIRECTORY);
    await getUsers();
    expect(await getUsers()).toEqual(NEW_DIRECTORY);
    expect(mockApiRequest).toHaveBeenCalledTimes(2);
  });
});
