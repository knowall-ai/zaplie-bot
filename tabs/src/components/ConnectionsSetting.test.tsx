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
import ConnectionsSetting from './ConnectionsSetting';

interface TestIdentity {
  provider: string;
  providerId: string;
  providerHandle: string;
  linkedAt: string;
}

interface MsalContextStub {
  instance: {
    acquireTokenSilent: (request: unknown) => Promise<{ idToken: string }>;
  };
  accounts: { homeAccountId: string }[];
}

const mockAcquireTokenSilent = jest.fn<
  Promise<{ idToken: string }>,
  [unknown]
>();
const mockUseMsal = jest.fn<MsalContextStub, []>();
const mockToastError = jest.fn<void, unknown[]>();
const mockToastSuccess = jest.fn<void, unknown[]>();
const mockGetMyIdentities = jest.fn<Promise<TestIdentity[]>, [string]>();
const mockGetGithubAuthorizeUrl = jest.fn<Promise<string>, [string]>();

jest.mock('@azure/msal-react', () => ({
  useMsal: () => mockUseMsal(),
}));

jest.mock('../services/identityService', () => ({
  getMyIdentities: (idToken: string) => mockGetMyIdentities(idToken),
  getGithubAuthorizeUrl: (idToken: string) =>
    mockGetGithubAuthorizeUrl(idToken),
}));

jest.mock('react-toastify', () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    success: (...args: unknown[]) => mockToastSuccess(...args),
  },
}));

const githubIdentity = {
  provider: 'github',
  providerId: '583231',
  providerHandle: 'octocat',
  linkedAt: '2026-08-11T12:00:00.000Z',
};

let container: HTMLDivElement;
let root: Root;

// react-dom/client mounting, not a Testing Library render, so the manual act
// wrapper is required and the helper keeps the act callback rule-clean.
function mountConnections(): void {
  root.render(<ConnectionsSetting />);
}

async function renderConnections(): Promise<void> {
  await act(async () => {
    mountConnections();
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await settle();
    }
  }
  throw lastError;
}

function getButton(label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    candidate => candidate.textContent?.trim() === label,
  );
  if (!button) {
    throw new Error(`Button "${label}" was not rendered`);
  }
  return button;
}

describe('ConnectionsSetting', () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    jest.clearAllMocks();
    window.history.replaceState({}, '', '/settings');
    mockAcquireTokenSilent.mockResolvedValue({ idToken: 'id-token' });
    mockUseMsal.mockReturnValue({
      instance: { acquireTokenSilent: mockAcquireTokenSilent },
      accounts: [{ homeAccountId: 'account-1' }],
    });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    jest.restoreAllMocks();
  });

  test('announces and renders a layout-matched loading state', async () => {
    mockGetMyIdentities.mockReturnValue(new Promise(() => undefined));

    await renderConnections();

    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toContain('Loading GitHub connection…');
    expect(status?.closest('[aria-busy]')?.getAttribute('aria-busy')).toBe(
      'true',
    );
    expect(() => getButton('Connect GitHub')).toThrow();
  });

  test('shows a clear action when GitHub is not connected', async () => {
    mockGetMyIdentities.mockResolvedValue([]);

    await renderConnections();
    await eventually(() =>
      expect(getButton('Connect GitHub').disabled).toBe(false),
    );

    expect(container.textContent).toContain(
      'receive rewards from pull requests',
    );
    expect(container.textContent).toContain('stable GitHub account ID');
  });

  test('renders signed-out visitors without requesting identities', async () => {
    mockUseMsal.mockReturnValue({
      instance: { acquireTokenSilent: mockAcquireTokenSilent },
      accounts: [],
    });

    await renderConnections();
    await eventually(() =>
      expect(getButton('Connect GitHub').disabled).toBe(false),
    );

    await act(async () => {
      getButton('Connect GitHub').click();
    });

    expect(mockGetMyIdentities).not.toHaveBeenCalled();
    expect(mockAcquireTokenSilent).not.toHaveBeenCalled();
  });

  test('shows the linked handle and connected status', async () => {
    mockGetMyIdentities.mockResolvedValue([githubIdentity]);

    await renderConnections();
    await eventually(() =>
      expect(container.textContent).toContain('Connected as @octocat'),
    );

    expect(container.textContent).toContain('Connected');
    expect(() => getButton('Connect GitHub')).toThrow();
  });

  test('offers a retry after loading fails', async () => {
    mockGetMyIdentities
      .mockRejectedValueOnce(new Error('backend unavailable'))
      .mockResolvedValueOnce([githubIdentity]);

    await renderConnections();
    await eventually(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "We couldn't load this connection. Try again.",
      ),
    );

    await act(async () => {
      getButton('Retry').click();
    });
    await eventually(() =>
      expect(container.textContent).toContain('Connected as @octocat'),
    );
    expect(mockGetMyIdentities).toHaveBeenCalledTimes(2);
  });

  test('restores the connect action and reports an authorize failure', async () => {
    mockGetMyIdentities.mockResolvedValue([]);
    mockGetGithubAuthorizeUrl.mockRejectedValue(
      new Error('authorize unavailable'),
    );

    await renderConnections();
    await eventually(() =>
      expect(getButton('Connect GitHub').disabled).toBe(false),
    );

    await act(async () => {
      getButton('Connect GitHub').click();
    });
    await eventually(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        'Could not start the GitHub connection.',
      ),
    );
    expect(getButton('Connect GitHub').disabled).toBe(false);
  });

  test('announces a successful OAuth return once and removes its query flag', async () => {
    window.history.replaceState(
      {},
      '',
      '/settings?github=connected&view=profile',
    );
    mockGetMyIdentities.mockResolvedValue([githubIdentity]);

    await renderConnections();
    await eventually(() =>
      expect(mockToastSuccess).toHaveBeenCalledWith('GitHub connected.'),
    );

    expect(window.location.search).toBe('?view=profile');
  });

  test('announces a repositories-connected return', async () => {
    window.history.replaceState({}, '', '/settings?github=repos_connected');
    mockGetMyIdentities.mockResolvedValue([githubIdentity]);

    await renderConnections();
    await eventually(() =>
      expect(mockToastSuccess).toHaveBeenCalledWith('Repositories connected.'),
    );

    expect(window.location.search).toBe('');
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test('reports a conflicting GitHub account without reassigning it', async () => {
    window.history.replaceState({}, '', '/settings?github=conflict');
    mockGetMyIdentities.mockResolvedValue([]);

    await renderConnections();
    await eventually(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        'That GitHub account is already linked to another person.',
      ),
    );

    expect(window.location.search).toBe('');
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  test('reports any other OAuth return as a generic failure', async () => {
    window.history.replaceState({}, '', '/settings?github=error');
    mockGetMyIdentities.mockResolvedValue([]);

    await renderConnections();
    await eventually(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        'Connecting GitHub failed. Please try again.',
      ),
    );

    expect(window.location.search).toBe('');
  });

  test('reports a repository install failure', async () => {
    window.history.replaceState({}, '', '/settings?github=install_error');
    mockGetMyIdentities.mockResolvedValue([]);

    await renderConnections();
    await eventually(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        'Connecting repositories failed. Please try again.',
      ),
    );

    expect(window.location.search).toBe('');
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });
});
