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
import { useMsal } from '@azure/msal-react';
import * as microsoftTeams from '@microsoft/teams-js';
import AuthEnd, {
  AUTH_FLOW_STORAGE_KEY,
  postAuthSignal,
  resolveSameOriginRedirect,
} from './AuthEnd';

jest.mock('@azure/msal-react', () => ({
  useMsal: require('@jest/globals').jest.fn(),
}));

jest.mock('@microsoft/teams-js', () => ({
  app: {
    initialize: require('@jest/globals').jest.fn(),
  },
  authentication: {
    notifySuccess: require('@jest/globals').jest.fn(),
    notifyFailure: require('@jest/globals').jest.fn(),
  },
}));

const mockUseMsal = jest.mocked(useMsal);
const mockTeamsInitialize = jest.mocked(microsoftTeams.app.initialize);
const mockNotifySuccess = jest.mocked(
  microsoftTeams.authentication.notifySuccess,
);
const mockNotifyFailure = jest.mocked(
  microsoftTeams.authentication.notifyFailure,
);
const mockHandleRedirectPromise = jest.fn<Promise<unknown>, []>();
const mockGetActiveAccount = jest.fn<unknown, []>();
const mockGetAllAccounts = jest.fn<unknown[], []>();
const mockSetActiveAccount = jest.fn<void, [unknown]>();

describe('AuthEnd', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    jest.clearAllMocks();
    sessionStorage.clear();
    window.history.replaceState({}, '', '/auth-end');
    Object.defineProperty(window, 'opener', {
      configurable: true,
      value: null,
    });
    mockUseMsal.mockReturnValue({
      instance: {
        handleRedirectPromise: mockHandleRedirectPromise,
        getActiveAccount: mockGetActiveAccount,
        getAllAccounts: mockGetAllAccounts,
        setActiveAccount: mockSetActiveAccount,
      },
    } as unknown as ReturnType<typeof useMsal>);
    mockGetActiveAccount.mockReturnValue(null);
    mockGetAllAccounts.mockReturnValue([]);
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

  const mountAuthEnd = () => {
    root.render(<AuthEnd />);
  };

  const renderAuthEnd = async () => {
    await act(async () => {
      mountAuthEnd();
    });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  };

  test('accepts only same-origin redirect targets', () => {
    const origin = 'https://portal.zaplie.example';

    expect(resolveSameOriginRedirect('/feed', origin)).toBe(`${origin}/feed`);
    expect(resolveSameOriginRedirect(`${origin}/wallet`, origin)).toBe(
      `${origin}/wallet`,
    );
    expect(resolveSameOriginRedirect('https://attacker.example', origin)).toBe(
      origin,
    );
    const scriptUrl = ['javascript', 'alert(1)'].join(':');
    expect(resolveSameOriginRedirect(scriptUrl, origin)).toBe(origin);
    expect(resolveSameOriginRedirect('not a valid url', origin)).toBe(
      `${origin}/not%20a%20valid%20url`,
    );
  });

  test('posts a minimal signal only to an open opener', () => {
    const postMessage = jest.fn();
    const focus = jest.fn();
    const opener = {
      closed: false,
      postMessage,
      focus,
    } as unknown as Window;

    expect(
      postAuthSignal(opener, 'auth-success', 'https://portal.example'),
    ).toBe(true);
    expect(postMessage).toHaveBeenCalledWith(
      { type: 'auth-success' },
      'https://portal.example',
    );
    expect(focus).toHaveBeenCalledTimes(1);
    expect(
      postAuthSignal(
        { ...opener, closed: true } as unknown as Window,
        'auth-success',
      ),
    ).toBe(false);
  });

  test('completes Teams authentication without returning an MSAL response', async () => {
    const account = { homeAccountId: 'account-1' };
    sessionStorage.setItem(
      AUTH_FLOW_STORAGE_KEY,
      JSON.stringify({
        redirectUrl: `${window.location.origin}/feed`,
        teamsAuth: true,
      }),
    );
    mockHandleRedirectPromise.mockResolvedValue({ account });
    mockTeamsInitialize.mockImplementation(async () => undefined);

    await renderAuthEnd();

    expect(mockSetActiveAccount).toHaveBeenCalledWith(account);
    expect(mockNotifySuccess).toHaveBeenCalledWith('auth-success');
    expect(mockNotifyFailure).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(AUTH_FLOW_STORAGE_KEY)).toBeNull();
  });

  test('shows a useful error when authentication cannot complete', async () => {
    mockHandleRedirectPromise.mockRejectedValue(new Error('redirect failed'));

    await renderAuthEnd();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'We could not complete sign-in. Close this window and try again.',
    );
  });
});
