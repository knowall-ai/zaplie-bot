import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import RequireAuth, { resetCallerReadyForTests } from './RequireAuth';

const mockEnsureCurrentUser = jest.fn<Promise<unknown>, []>();
const mockNavigate = jest.fn();
const mockAcquireTokenSilent = jest.fn<Promise<unknown>, [unknown]>();

// The account list must be the same object every render: RequireAuth keys its
// effects on `accounts`, so a fresh array each call would re-run them forever.
const accounts: unknown[] = [];

jest.mock('@azure/msal-react', () => ({
  useMsal: () => ({
    instance: {
      acquireTokenSilent: (request: unknown) => mockAcquireTokenSilent(request),
    },
    accounts,
    inProgress: 'none',
  }),
}));

// react-router-dom v7's ESM entry does not resolve under CRA's Jest config.
jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

jest.mock('../services/lnbits/users', () => ({
  ensureCurrentUser: () => mockEnsureCurrentUser(),
}));

jest.mock('../utils/logger', () => ({
  logger: { error: () => undefined },
}));

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('RequireAuth', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    jest.clearAllMocks();
    resetCallerReadyForTests();
    accounts.length = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  const mount = () => {
    root.render(
      <RequireAuth>
        <p data-testid="page">Feed</p>
      </RequireAuth>,
    );
  };

  const render = async () => {
    await act(async () => {
      mount();
    });
    await flush();
  };

  test('shows the page only once the signed-in person has an LNbits user', async () => {
    accounts.push({ localAccountId: 'caller-oid' });
    let settle: (value: unknown) => void = () => undefined;
    mockEnsureCurrentUser.mockReturnValue(
      new Promise(resolve => {
        settle = resolve;
      }),
    );

    await render();

    expect(container.querySelector('[data-testid="page"]')).toBeNull();
    expect(mockEnsureCurrentUser).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle({ user: { id: 'user-1' }, created: true, createdWallets: [] });
    });
    await flush();

    expect(container.querySelector('[data-testid="page"]')?.textContent).toBe(
      'Feed',
    );
  });

  test('provisions once per page, however many guarded routes mount', async () => {
    accounts.push({ localAccountId: 'caller-oid' });
    mockEnsureCurrentUser.mockResolvedValue({
      user: { id: 'user-1' },
      created: false,
      createdWallets: [],
    });

    await render();
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await render();

    expect(mockEnsureCurrentUser).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="page"]')).not.toBeNull();
  });

  test('still shows the page when provisioning fails, so the pages report their own errors', async () => {
    accounts.push({ localAccountId: 'caller-oid' });
    mockEnsureCurrentUser.mockRejectedValue(new Error('gateway down'));

    await render();

    expect(container.querySelector('[data-testid="page"]')).not.toBeNull();
  });

  test('tries again on the next guarded mount after a failure', async () => {
    accounts.push({ localAccountId: 'caller-oid' });
    mockEnsureCurrentUser.mockRejectedValueOnce(new Error('gateway down'));
    mockEnsureCurrentUser.mockResolvedValue({
      user: { id: 'user-1' },
      created: true,
      createdWallets: [],
    });

    await render();
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await render();

    expect(mockEnsureCurrentUser).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="page"]')).not.toBeNull();
  });

  test('a different account signing in without a reload is provisioned too', async () => {
    accounts.push({ homeAccountId: 'first.home', localAccountId: 'first' });
    let settleSecond: (value: unknown) => void = () => undefined;
    mockEnsureCurrentUser
      .mockResolvedValueOnce({
        user: { id: 'user-1' },
        created: false,
        createdWallets: [],
      })
      .mockReturnValueOnce(
        new Promise(resolve => {
          settleSecond = resolve;
        }),
      );

    await render();
    expect(container.querySelector('[data-testid="page"]')).not.toBeNull();

    // Sign out, sign in as somebody else: the same accounts array, new entry.
    accounts.length = 0;
    accounts.push({ homeAccountId: 'second.home', localAccountId: 'second' });
    await render();

    expect(mockEnsureCurrentUser).toHaveBeenCalledTimes(2);
    // The first person's readiness must not show the page to the second.
    expect(container.querySelector('[data-testid="page"]')).toBeNull();

    await act(async () => {
      settleSecond({
        user: { id: 'user-2' },
        created: true,
        createdWallets: [],
      });
    });
    await flush();
    expect(container.querySelector('[data-testid="page"]')).not.toBeNull();
  });

  test('sends a signed-out visitor to /login without provisioning anything', async () => {
    mockAcquireTokenSilent.mockRejectedValue(new Error('no session'));

    await render();

    expect(mockNavigate).toHaveBeenCalledWith('/login', { replace: true });
    expect(mockEnsureCurrentUser).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="page"]')).toBeNull();
  });
});
