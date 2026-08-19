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
import { clearApiCache } from '../services/lnbits/cache';
import { teamsContextQueryKey } from '../services/teamsContextService';
import { useTeamsAuth } from './useTeamsAuth';

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

jest.mock('../services/lnbits/cache', () => ({
  clearApiCache: require('@jest/globals').jest.fn(),
}));

const mockInitialize = jest.mocked(microsoftTeams.app.initialize);
const mockGetContext = jest.mocked(microsoftTeams.app.getContext);
const mockIsInitialized = jest.mocked(microsoftTeams.app.isInitialized);
const mockUseMsal = jest.mocked(useMsal);
const mockLogoutPopup = jest.fn(async () => undefined);
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
    mockClearApiCache.mockReset();
    mockToastError.mockReset();
    mockUseMsal.mockReset();
    mockUseMsal.mockReturnValue({
      instance: { logoutPopup: mockLogoutPopup },
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

  test('preserves logout cache clearing and MSAL logout', async () => {
    mockIsInitialized.mockReturnValue(false);
    mockInitialize.mockRejectedValue(new Error('Not running inside Teams'));
    mockLogoutPopup.mockResolvedValue(undefined);
    const client = createQueryClient();

    await renderConsumers(client, 1);
    const button = container.querySelector('button');

    await act(async () => {
      button?.click();
    });

    expect(mockClearApiCache).toHaveBeenCalledTimes(1);
    expect(mockLogoutPopup).toHaveBeenCalledWith({
      postLogoutRedirectUri: `${window.location.origin}/login`,
      account: null,
    });
  });
});
