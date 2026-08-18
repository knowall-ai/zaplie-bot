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
import { InteractionStatus } from '@azure/msal-browser';
import AuthStart from './AuthStart';
import { AUTH_FLOW_STORAGE_KEY } from './AuthEnd';

jest.mock('@azure/msal-react', () => ({
  useMsal: require('@jest/globals').jest.fn(),
}));

jest.mock('@microsoft/teams-js', () => ({
  app: { initialize: require('@jest/globals').jest.fn() },
  authentication: {
    notifySuccess: require('@jest/globals').jest.fn(),
    notifyFailure: require('@jest/globals').jest.fn(),
  },
}));

jest.mock('./services/authConfig', () => ({
  loginRequest: { scopes: ['User.Read'] },
}));

const mockUseMsal = jest.mocked(useMsal);
const mockLoginRedirect = jest.fn<Promise<void>, [unknown]>();
const mockGetAllAccounts = jest.fn<unknown[], []>();
const mockGetActiveAccount = jest.fn<unknown, []>();
const mockSetActiveAccount = jest.fn<void, [unknown]>();

describe('AuthStart', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    jest.clearAllMocks();
    sessionStorage.clear();
    window.history.replaceState({}, '', '/auth-start');
    mockUseMsal.mockReturnValue({
      instance: {
        loginRedirect: mockLoginRedirect,
        getAllAccounts: mockGetAllAccounts,
        getActiveAccount: mockGetActiveAccount,
        setActiveAccount: mockSetActiveAccount,
      },
      inProgress: InteractionStatus.None,
    } as unknown as ReturnType<typeof useMsal>);
    mockGetAllAccounts.mockReturnValue([]);
    mockGetActiveAccount.mockReturnValue(null);
    mockLoginRedirect.mockResolvedValue(undefined);
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

  const mountAuthStart = () => {
    root.render(<AuthStart />);
  };

  const renderAuthStart = async () => {
    await act(async () => {
      mountAuthStart();
    });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  };

  test('stores only a same-origin return target before redirecting', async () => {
    window.history.replaceState(
      {},
      '',
      '/auth-start?teamsAuth=1&redirectUrl=https%3A%2F%2Fattacker.example',
    );

    await renderAuthStart();

    expect(
      JSON.parse(sessionStorage.getItem(AUTH_FLOW_STORAGE_KEY) || '{}'),
    ).toEqual({
      redirectUrl: window.location.origin,
      teamsAuth: true,
    });
    expect(mockLoginRedirect).toHaveBeenCalledWith({
      scopes: ['User.Read'],
      redirectUri: `${window.location.origin}/auth-end`,
    });
  });

  test('shows an error when redirect login cannot start', async () => {
    mockLoginRedirect.mockRejectedValue(new Error('redirect unavailable'));

    await renderAuthStart();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'We could not start sign-in. Close this window and try again.',
    );
  });
});
