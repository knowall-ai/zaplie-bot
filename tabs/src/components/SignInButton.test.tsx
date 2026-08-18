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
import { InteractionStatus } from '@azure/msal-browser';
import { SignInButton } from './SignInButton';

jest.mock('@azure/msal-react', () => ({
  useMsal: require('@jest/globals').jest.fn(),
}));

jest.mock('@microsoft/teams-js', () => ({
  app: {
    initialize: require('@jest/globals').jest.fn(),
    getContext: require('@jest/globals').jest.fn(),
  },
  authentication: {
    authenticate: require('@jest/globals').jest.fn(),
  },
}));

jest.mock('../services/authConfig', () => ({
  loginRequest: { scopes: ['User.Read'] },
}));

const mockUseMsal = jest.mocked(useMsal);
const mockTeamsInitialize = jest.mocked(microsoftTeams.app.initialize);
const mockGetContext = jest.mocked(microsoftTeams.app.getContext);
const mockAuthenticate = jest.mocked(
  microsoftTeams.authentication.authenticate,
);
const mockLoginRedirect = jest.fn<Promise<void>, [unknown]>();
const mockLoginPopup = jest.fn<Promise<unknown>, [unknown]>();
const mockGetAllAccounts = jest.fn<unknown[], []>();
const mockSetActiveAccount = jest.fn<void, [unknown]>();
const mockAcquireTokenSilent = jest.fn<Promise<unknown>, [unknown]>();

describe('SignInButton', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    jest.clearAllMocks();
    window.name = '';
    window.history.replaceState({}, '', '/login');
    sessionStorage.clear();
    localStorage.clear();
    mockUseMsal.mockReturnValue({
      instance: {
        loginRedirect: mockLoginRedirect,
        loginPopup: mockLoginPopup,
        getAllAccounts: mockGetAllAccounts,
        setActiveAccount: mockSetActiveAccount,
        acquireTokenSilent: mockAcquireTokenSilent,
      },
      inProgress: InteractionStatus.None,
    } as unknown as ReturnType<typeof useMsal>);
    mockGetAllAccounts.mockReturnValue([]);
    mockLoginRedirect.mockResolvedValue(undefined);
    mockLoginPopup.mockResolvedValue(undefined);
    mockAcquireTokenSilent.mockResolvedValue({ idToken: 'not-rendered' });
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

  const mountButton = () => {
    root.render(<SignInButton />);
  };

  const renderButton = async () => {
    await act(async () => {
      mountButton();
    });
  };

  const clickSignIn = async () => {
    const button = container.querySelector('button');
    if (!button) {
      throw new Error('Sign In button was not rendered');
    }
    await act(async () => {
      button.click();
    });
  };

  test('uses redirect login in a web browser', async () => {
    await renderButton();
    await clickSignIn();

    expect(mockLoginRedirect).toHaveBeenCalledWith({
      scopes: ['User.Read'],
      prompt: 'select_account',
    });
    expect(mockTeamsInitialize).not.toHaveBeenCalled();
  });

  test('preserves the Teams popup flow without clearing MSAL storage', async () => {
    const account = { homeAccountId: 'account-1' };
    window.history.replaceState({}, '', '/login?inTeams=1');
    sessionStorage.setItem(
      'msal.interaction.status',
      'interaction_in_progress',
    );
    localStorage.setItem('msal.interaction.status', 'interaction_in_progress');
    mockTeamsInitialize.mockImplementation(async () => undefined);
    mockGetContext.mockImplementation(async () => ({}) as never);
    mockAuthenticate.mockImplementation(async () => 'auth-success');
    mockGetAllAccounts.mockReturnValue([account]);

    await renderButton();
    await clickSignIn();

    const request = mockAuthenticate.mock.calls[0]?.[0];
    if (!request) {
      throw new Error('Teams authentication was not requested');
    }
    const authUrl = new URL(request.url);
    expect(authUrl.origin).toBe(window.location.origin);
    expect(authUrl.pathname).toBe('/auth-start');
    expect(authUrl.searchParams.get('teamsAuth')).toBe('1');
    expect(authUrl.searchParams.get('redirectUrl')).toBe(window.location.href);
    expect(mockSetActiveAccount).toHaveBeenCalledWith(account);
    expect(mockAcquireTokenSilent).toHaveBeenCalledWith({
      scopes: ['User.Read'],
      account,
    });
    expect(sessionStorage.getItem('msal.interaction.status')).toBe(
      'interaction_in_progress',
    );
    expect(localStorage.getItem('msal.interaction.status')).toBe(
      'interaction_in_progress',
    );
  });

  test('renders an error when both Teams and interactive login fail', async () => {
    window.history.replaceState({}, '', '/login?inTeams=1');
    mockTeamsInitialize.mockRejectedValue(new Error('Teams unavailable'));
    mockLoginPopup.mockRejectedValue(new Error('Popup blocked'));

    await renderButton();
    await clickSignIn();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'We could not sign you in. Please try again.',
    );
  });
});
