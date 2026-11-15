import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  beforeEach,
  afterEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import { useMsal } from '@azure/msal-react';
import { InteractionStatus } from '@azure/msal-browser';
import * as microsoftTeams from '@microsoft/teams-js';
import { toast } from 'react-toastify';
import { createQueryClient } from '../query/queryClient';
import { clearApiCache } from '../services/wallet/cache';
import { teamsContextQueryKey } from '../services/teamsContextService';
import {
  SILENT_SIGN_IN_GUARD_KEY,
  clearSilentSignInGuard,
  hasAttemptedSilentSignIn,
} from '../services/silentSignIn';
import { useTeamsAuth } from './useTeamsAuth';
import { SignOutButton } from '../components/SignOutButton';

jest.mock('@microsoft/teams-js', () => ({
  app: {
    initialize: require('@jest/globals').jest.fn(),
    getContext: require('@jest/globals').jest.fn(),
    isInitialized: require('@jest/globals').jest.fn(),
  },
}));

jest.mock('@azure/msal-react', () => ({
  useMsal: require('@jest/globals').jest.fn(),
}));

jest.mock('react-toastify', () => ({
  toast: { error: require('@jest/globals').jest.fn() },
}));

jest.mock('../services/wallet/cache', () => ({
  clearApiCache: require('@jest/globals').jest.fn(),
}));

const mockInitialize = jest.mocked(microsoftTeams.app.initialize);
const mockGetContext = jest.mocked(microsoftTeams.app.getContext);
const mockIsInitialized = jest.mocked(microsoftTeams.app.isInitialized);
const mockUseMsal = jest.mocked(useMsal);
const mockLogoutPopup = jest.fn(async () => undefined);
const mockLogoutRedirect = jest.fn(async () => undefined);
const mockClearApiCache = jest.mocked(clearApiCache);
const mockToastError = jest.mocked(toast.error);
const mockTeamsContext = {} as Awaited<
  ReturnType<typeof microsoftTeams.app.getContext>
>;

const AuthState = ({ id }: { id: string }) => {
  const { isInTeams, isTeamsInitializing, handleLogout } = useTeamsAuth();

  return (
    <button data-consumer={id} onClick={() => void handleLogout()}>
      {isTeamsInitializing ? 'loading' : isInTeams ? 'teams' : 'web'}
    </button>
  );
};

describe('useTeamsAuth', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockInitialize.mockReset();
    mockGetContext.mockReset();
    mockIsInitialized.mockReset();
    mockLogoutPopup.mockReset();
    mockLogoutRedirect.mockReset();
    mockClearApiCache.mockReset();
    mockToastError.mockReset();
    mockUseMsal.mockReset();
    mockUseMsal.mockReturnValue({
      instance: {
        logoutPopup: mockLogoutPopup,
        logoutRedirect: mockLogoutRedirect,
      },
      accounts: [],
      inProgress: InteractionStatus.None,
    } as unknown as ReturnType<typeof useMsal>);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  const renderConsumers = async (client: QueryClient, count = 3) => {
    // root.render is the react-dom client API, not a Testing Library util, so act is required here.
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          {Array.from({ length: count }, (_, index) => (
            <AuthState key={index} id={`consumer-${index}`} />
          ))}
        </QueryClientProvider>,
      );
    });

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  };

  test('deduplicates Teams initialization across consumers', async () => {
    mockIsInitialized.mockReturnValue(false);
    mockInitialize.mockResolvedValue(undefined);
    mockGetContext.mockResolvedValue(mockTeamsContext);
    const client = createQueryClient();

    await renderConsumers(client);

    expect(mockInitialize).toHaveBeenCalledTimes(1);
    expect(mockGetContext).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(teamsContextQueryKey)).toBe(true);
    expect(
      Array.from(container.querySelectorAll('button')).map(
        button => button.textContent,
      ),
    ).toEqual(['teams', 'teams', 'teams']);
  });

  test('caches the browser fallback without retries or remount work', async () => {
    mockIsInitialized.mockReturnValue(false);
    mockInitialize.mockRejectedValue(new Error('Not running inside Teams'));
    const client = createQueryClient();

    await renderConsumers(client);
    expect(client.getQueryData(teamsContextQueryKey)).toBe(false);

    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      root.render(<QueryClientProvider client={client} />);
    });
    await renderConsumers(client, 1);

    expect(mockInitialize).toHaveBeenCalledTimes(1);
    expect(mockGetContext).not.toHaveBeenCalled();
    expect(container.querySelector('button')?.textContent).toBe('web');
  });

  test('uses an existing Teams initialization', async () => {
    mockIsInitialized.mockReturnValue(true);
    mockGetContext.mockResolvedValue(mockTeamsContext);
    const client = createQueryClient();

    await renderConsumers(client, 1);

    expect(mockInitialize).not.toHaveBeenCalled();
    expect(mockGetContext).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(teamsContextQueryKey)).toBe(true);
  });

  // Renders one consumer in a browser or in Teams and returns its button.
  const mountHost = async (host: 'web' | 'teams') => {
    if (host === 'teams') {
      mockIsInitialized.mockReturnValue(true);
      mockGetContext.mockResolvedValue(mockTeamsContext);
    } else {
      mockIsInitialized.mockReturnValue(false);
      mockInitialize.mockRejectedValue(new Error('Not running inside Teams'));
    }
    await renderConsumers(createQueryClient(), 1);
    const button = container.querySelector<HTMLButtonElement>(
      '[data-consumer="consumer-0"]',
    );
    expect(button?.textContent).toBe(host);
    return button as HTMLButtonElement;
  };

  test('a browser signs out with a full-page redirect to the sign-in page', async () => {
    const button = await mountHost('web');

    await act(async () => {
      button.click();
    });

    expect(mockClearApiCache).toHaveBeenCalledTimes(1);
    expect(mockLogoutRedirect).toHaveBeenCalledTimes(1);
    expect(mockLogoutRedirect).toHaveBeenCalledWith({
      postLogoutRedirectUri: `${window.location.origin}/login`,
      account: null,
    });
    expect(mockLogoutPopup).not.toHaveBeenCalled();
  });

  test('the browser sign-out lands on /portal/login under the portal base path', async () => {
    const publicUrl = process.env.PUBLIC_URL;
    process.env.PUBLIC_URL = '/portal';
    try {
      const account = { homeAccountId: 'person' };
      mockUseMsal.mockReturnValue({
        instance: {
          logoutPopup: mockLogoutPopup,
          logoutRedirect: mockLogoutRedirect,
        },
        accounts: [account],
        inProgress: InteractionStatus.None,
      } as unknown as ReturnType<typeof useMsal>);
      const button = await mountHost('web');

      await act(async () => {
        button.click();
      });

      expect(mockLogoutRedirect).toHaveBeenCalledWith({
        postLogoutRedirectUri: `${window.location.origin}/portal/login`,
        account,
      });
    } finally {
      if (publicUrl === undefined) {
        delete process.env.PUBLIC_URL;
      } else {
        process.env.PUBLIC_URL = publicUrl;
      }
    }
  });

  test('Teams signs out in a popup, because the tab is an iframe', async () => {
    const button = await mountHost('teams');

    await act(async () => {
      button.click();
    });

    expect(mockClearApiCache).toHaveBeenCalledTimes(1);
    expect(mockLogoutPopup).toHaveBeenCalledWith({
      postLogoutRedirectUri: `${window.location.origin}/login`,
      account: null,
    });
    expect(mockLogoutRedirect).not.toHaveBeenCalled();
  });

  test.each(['web', 'teams'] as const)(
    'logout in %s blocks a silent sign-in for the rest of the tab session',
    async host => {
      clearSilentSignInGuard();
      const button = await mountHost(host);

      await act(async () => {
        button.click();
      });

      expect(sessionStorage.getItem(SILENT_SIGN_IN_GUARD_KEY)).not.toBeNull();
      expect(hasAttemptedSilentSignIn()).toBe(true);
    },
  );

  test('does nothing while MSAL has another interaction in progress', async () => {
    mockUseMsal.mockReturnValue({
      instance: {
        logoutPopup: mockLogoutPopup,
        logoutRedirect: mockLogoutRedirect,
      },
      accounts: [],
      inProgress: InteractionStatus.Logout,
    } as unknown as ReturnType<typeof useMsal>);
    const button = await mountHost('web');

    await act(async () => {
      button.click();
    });

    expect(mockClearApiCache).not.toHaveBeenCalled();
    expect(mockLogoutRedirect).not.toHaveBeenCalled();
    expect(mockLogoutPopup).not.toHaveBeenCalled();
  });

  test('does not sign out while the host is still being detected', async () => {
    // Until detection settles isInTeams is only a default, so the hook would
    // pick the browser redirect inside a Teams iframe.
    mockIsInitialized.mockReturnValue(false);
    mockInitialize.mockReturnValue(new Promise(() => undefined));
    await renderConsumers(createQueryClient(), 1);
    const button = container.querySelector<HTMLButtonElement>(
      '[data-consumer="consumer-0"]',
    ) as HTMLButtonElement;
    expect(button.textContent).toBe('loading');

    await act(async () => {
      button.click();
    });

    expect(mockLogoutRedirect).not.toHaveBeenCalled();
    expect(mockLogoutPopup).not.toHaveBeenCalled();
    expect(mockClearApiCache).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test('SignOutButton is disabled while the host is still being detected', async () => {
    mockIsInitialized.mockReturnValue(false);
    mockInitialize.mockReturnValue(new Promise(() => undefined));
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      root.render(
        <QueryClientProvider client={createQueryClient()}>
          <SignOutButton />
        </QueryClientProvider>,
      );
    });

    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Sign Out"]',
    );
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toBe('Sign Out');
  });

  test('a second click while signing out starts no second sign-out', async () => {
    // A redirect only settles once the page has gone.
    mockLogoutRedirect.mockImplementation(() => new Promise(() => undefined));
    const button = await mountHost('web');

    await act(async () => {
      button.click();
      button.click();
    });

    expect(mockLogoutRedirect).toHaveBeenCalledTimes(1);
  });

  test('a failed sign-out shows a toast and can be tried again', async () => {
    mockLogoutRedirect.mockRejectedValueOnce(new Error('redirect_in_iframe'));
    const button = await mountHost('web');

    await act(async () => {
      button.click();
    });

    expect(mockToastError).toHaveBeenCalledWith(
      'Failed to sign out. Please try again.',
    );

    await act(async () => {
      button.click();
    });

    expect(mockLogoutRedirect).toHaveBeenCalledTimes(2);
  });
});
