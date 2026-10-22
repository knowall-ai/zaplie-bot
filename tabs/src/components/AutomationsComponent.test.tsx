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
import AutomationsComponent from './AutomationsComponent';
import type { AutomationsStats } from '../services/automationsStatsService';
import type { WebhookKey } from '../services/webhookKeysService';
import type { GithubSetupStatus } from '../services/setupService';

interface MsalContextStub {
  instance: Record<string, unknown>;
  accounts: { homeAccountId: string }[];
}

const mockUseMsal = jest.fn<MsalContextStub, []>();
const mockAcquireIdToken = jest.fn<Promise<string>, []>();
const mockToastError = jest.fn<void, unknown[]>();
const mockToastSuccess = jest.fn<void, unknown[]>();
const mockGetGithubConnection = jest.fn<
  Promise<{ connected: boolean }>,
  [string]
>();
const mockGetAutomationsStats = jest.fn<Promise<AutomationsStats>, [string]>();
const mockGetWebhookKeys = jest.fn<Promise<WebhookKey[]>, [string]>();
const mockIsAdmin = jest.fn<boolean, []>();
const mockGetGithubSetupStatus = jest.fn<
  Promise<GithubSetupStatus>,
  [string]
>();
const mockStartGithubAppCreation = jest.fn<
  Promise<void>,
  [string, string | undefined]
>();

jest.mock('@azure/msal-react', () => ({
  useMsal: () => mockUseMsal(),
}));

jest.mock('../services/adminRole', () => ({
  acquireIdToken: () => mockAcquireIdToken(),
  isZaplieAdmin: () => mockIsAdmin(),
}));

jest.mock('../services/setupService', () => ({
  getGithubSetupStatus: (idToken: string) => mockGetGithubSetupStatus(idToken),
  startGithubAppCreation: (idToken: string, organization?: string) =>
    mockStartGithubAppCreation(idToken, organization),
}));

jest.mock('../apiService', () => ({
  getAutomations: () => Promise.resolve({ repos: [] }),
  updateAutomations: () => Promise.resolve({ repos: [] }),
  getRewardAmounts: () => Promise.resolve({ rewardAmounts: {} }),
  updateRewardAmounts: () => Promise.resolve({ rewardAmounts: {} }),
}));

jest.mock('../services/connectionsService', () => ({
  getGithubConnection: (idToken: string) => mockGetGithubConnection(idToken),
  getGithubInstallUrl: () => Promise.resolve('https://github.test/install'),
}));

jest.mock('../services/automationsStatsService', () => ({
  getAutomationsStats: (idToken: string) => mockGetAutomationsStats(idToken),
}));

jest.mock('../services/webhookKeysService', () => ({
  getWebhookKeys: (idToken: string) => mockGetWebhookKeys(idToken),
  createWebhookKey: () => Promise.resolve({ key: 'zpl_x', id: 'id' }),
  revokeWebhookKey: () => Promise.resolve(),
}));

jest.mock('react-toastify', () => ({
  ToastContainer: () => null,
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    success: (...args: unknown[]) => mockToastSuccess(...args),
  },
}));

const webhookKey: WebhookKey = {
  id: '6f0b1e2c-6a4d-4c1a-9a0d-0b6a9c2f1e33',
  label: 'Treasury payout runner',
  last4: 'a1b2',
  createdAt: '2026-08-01T10:00:00.000Z',
  revokedAt: null,
};

const emptyStats: AutomationsStats = {
  paidSatsThisMonth: 0,
  paymentsThisMonth: 0,
  runsByEventType: {},
  engagementByAudience: { teammates: [], copilots: [], customers: [] },
  recentPayments: [],
};

const createdStatus: GithubSetupStatus = {
  created: true,
  slug: 'zaplie-rewards-abcd',
  htmlUrl: 'https://github.com/apps/zaplie-rewards-abcd',
  source: 'manifest',
  installationReady: true,
};

let container: HTMLDivElement;
let root: Root;

function mountAutomations(): void {
  root.render(<AutomationsComponent />);
}

const renderAutomations = async () => {
  await act(async () => {
    mountAutomations();
  });
  // Let the two load effects settle.
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  jest.clearAllMocks();
  mockUseMsal.mockReturnValue({
    instance: {},
    accounts: [{ homeAccountId: 'account-1' }],
  });
  mockAcquireIdToken.mockResolvedValue('id-token');
  mockIsAdmin.mockReturnValue(true);
  mockGetGithubSetupStatus.mockResolvedValue(createdStatus);
  mockGetGithubConnection.mockResolvedValue({ connected: true });
  mockGetWebhookKeys.mockResolvedValue([webhookKey]);
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

describe('AutomationsComponent panel independence', () => {
  test('renders the other panels while stats is still pending', async () => {
    // Never resolves: under Promise.all/allSettled the banner and the key list
    // would still be waiting here, so this is what proves they are independent
    // rather than merely tolerant of a rejection in the same microtask.
    mockGetAutomationsStats.mockReturnValue(new Promise(() => undefined));

    await renderAutomations();

    expect(container.textContent).toContain('App installed');
    expect(container.textContent).toContain(webhookKey.label);
    // Stats itself is still loading, so no error state yet.
    expect(container.textContent).toContain('Loading recipient activity');
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test('the Logic Apps pilot card names every remaining production blocker', async () => {
    mockGetAutomationsStats.mockResolvedValue(emptyStats);

    await renderAutomations();

    const card = container.querySelector(
      '[data-testid="logic-apps-pilot-card"]',
    );
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('Draft — not production ready');
    expect(card?.textContent).toContain(
      'remains blocked until aggregate budget controls, automatic ' +
        'reconciliation of uncertain payment outcomes and GitHub webhook ' +
        'signature verification land.',
    );
    expect(card?.textContent).not.toContain('durable idempotency');
  });

  test('shows a stats-only error and keeps the other panels when stats rejects', async () => {
    mockGetAutomationsStats.mockRejectedValue(
      new Error('Automations stats response is malformed.'),
    );

    await renderAutomations();

    expect(container.textContent).toContain('App installed');
    expect(container.textContent).toContain(webhookKey.label);
    // Stats gets its own, non-blocking error state.
    expect(container.textContent).toContain(
      'Recipient activity is unavailable right now.',
    );
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    // No generic connection toast: the connection call succeeded.
    expect(mockToastError).not.toHaveBeenCalledWith(
      'Could not load connection status.',
    );
  });

  test('still renders API keys when the GitHub connection rejects', async () => {
    mockGetAutomationsStats.mockResolvedValue(emptyStats);
    mockGetGithubConnection.mockRejectedValue(new Error('502 from GitHub'));

    await renderAutomations();

    expect(container.textContent).toContain(webhookKey.label);
    expect(mockToastError).toHaveBeenCalledWith(
      'Could not load connection status.',
    );
    // The previous account's banner must not survive a failed reload.
    expect(container.textContent).toContain('Not connected yet');
  });

  test('drops the previous key labels when the key request rejects', async () => {
    mockGetAutomationsStats.mockResolvedValue(emptyStats);
    mockGetWebhookKeys.mockRejectedValue(new Error('403'));

    await renderAutomations();

    expect(container.textContent).not.toContain(webhookKey.label);
    expect(mockToastError).toHaveBeenCalledWith('Could not load the API keys.');
  });

  test('clears the previous account state when a reload for a new account fails', async () => {
    // Load one account successfully first, so the assertions below are about
    // state actually being cleared rather than never having been set.
    mockGetAutomationsStats.mockResolvedValue(emptyStats);
    await renderAutomations();
    expect(container.textContent).toContain('App installed');
    expect(container.textContent).toContain(webhookKey.label);

    // Switch account and fail every request for the new one.
    mockUseMsal.mockReturnValue({
      instance: {},
      accounts: [{ homeAccountId: 'account-2' }],
    });
    mockGetGithubConnection.mockRejectedValue(new Error('403'));
    mockGetAutomationsStats.mockRejectedValue(new Error('403'));
    mockGetWebhookKeys.mockRejectedValue(new Error('403'));

    await renderAutomations();

    expect(container.textContent).toContain('Not connected yet');
    expect(container.textContent).not.toContain(webhookKey.label);
    expect(container.textContent).toContain(
      'Recipient activity is unavailable right now.',
    );
  });

  test('drops the previous account state before the new loads settle', async () => {
    mockGetAutomationsStats.mockResolvedValue(emptyStats);
    await renderAutomations();
    expect(container.textContent).toContain('App installed');
    expect(container.textContent).toContain(webhookKey.label);

    // Switch account and let every request hang. Nothing settles, so this can
    // only pass if the state is reset on the account change itself.
    mockUseMsal.mockReturnValue({
      instance: {},
      accounts: [{ homeAccountId: 'account-2' }],
    });
    const pending = () => new Promise(() => undefined);
    mockGetGithubConnection.mockImplementation(pending as never);
    mockGetAutomationsStats.mockImplementation(pending as never);
    mockGetWebhookKeys.mockImplementation(pending as never);

    await renderAutomations();

    expect(container.textContent).toContain('Not connected yet');
    expect(container.textContent).not.toContain(webhookKey.label);
  });
});

// React tracks an input's value itself, so set it through the native setter
// and dispatch the event React listens for.
const typeInto = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const findButton = (label: string) =>
  Array.from(container.querySelectorAll('button')).find(
    button => button.textContent === label,
  );

describe('AutomationsComponent GitHub App setup', () => {
  beforeEach(() => {
    mockGetAutomationsStats.mockResolvedValue(emptyStats);
    mockStartGithubAppCreation.mockResolvedValue(undefined);
  });

  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  test('an admin can create the app before it exists, and cannot connect repositories yet', async () => {
    mockGetGithubSetupStatus.mockResolvedValue({
      created: false,
      source: 'none',
      installationReady: false,
    });

    await renderAutomations();

    expect(container.textContent).toContain('GitHub App: not created');
    const connect = findButton('Connect repositories');
    expect(connect?.disabled).toBe(true);
    expect(container.textContent).toContain(
      'Create the Zaplie GitHub App first',
    );

    const create = findButton('Create the Zaplie GitHub App');
    expect(create).toBeDefined();
    await act(async () => {
      create?.click();
    });

    // Empty organisation: GitHub registers it under the admin's own account.
    expect(mockStartGithubAppCreation).toHaveBeenCalledWith(
      'id-token',
      undefined,
    );
    expect(findButton('Redirecting to GitHub...')?.disabled).toBe(true);
  });

  test('the organisation entered is passed on so the App can be installed there', async () => {
    mockGetGithubSetupStatus.mockResolvedValue({
      created: false,
      source: 'none',
      installationReady: false,
    });

    await renderAutomations();
    const input = container.querySelector<HTMLInputElement>(
      'input[placeholder="your-org"]',
    );
    expect(input).not.toBeNull();
    expect(container.textContent).toContain(
      'GitHub organisation that owns the repositories',
    );
    await act(async () => {
      typeInto(input as HTMLInputElement, '  knowall-ai ');
    });
    await act(async () => {
      findButton('Create the Zaplie GitHub App')?.click();
    });

    expect(mockStartGithubAppCreation).toHaveBeenCalledWith(
      'id-token',
      'knowall-ai',
    );
  });

  test('an organisation the server rejects gets a specific toast', async () => {
    mockGetGithubSetupStatus.mockResolvedValue({
      created: false,
      source: 'none',
      installationReady: false,
    });
    mockStartGithubAppCreation.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 400'), {
        isAxiosError: true,
        response: { status: 400 },
      }),
    );

    await renderAutomations();
    await act(async () => {
      typeInto(
        container.querySelector<HTMLInputElement>(
          'input[placeholder="your-org"]',
        ) as HTMLInputElement,
        'not/an/org',
      );
    });
    await act(async () => {
      findButton('Create the Zaplie GitHub App')?.click();
    });

    expect(mockToastError).toHaveBeenCalledWith(
      'Enter the organisation as its GitHub login, like knowall-ai.',
    );
    expect(findButton('Create the Zaplie GitHub App')?.disabled).toBe(false);
  });

  test('a failed start re-enables the create button with a toast', async () => {
    mockGetGithubSetupStatus.mockResolvedValue({
      created: false,
      source: 'none',
      installationReady: false,
    });
    mockStartGithubAppCreation.mockRejectedValue(new Error('403'));

    await renderAutomations();
    await act(async () => {
      findButton('Create the Zaplie GitHub App')?.click();
    });

    expect(mockToastError).toHaveBeenCalledWith(
      'Could not start creating the GitHub App.',
    );
    expect(findButton('Create the Zaplie GitHub App')?.disabled).toBe(false);
  });

  test('an admin sees the created app linked to GitHub', async () => {
    await renderAutomations();

    const link = container.querySelector(
      'a[href="https://github.com/apps/zaplie-rewards-abcd"]',
    );
    expect(link?.textContent).toBe('zaplie-rewards-abcd');
    expect(findButton('Create the Zaplie GitHub App')).toBeUndefined();
    expect(findButton('Connect repositories')?.disabled).toBe(false);
  });

  test('an env-configured app needs no creation', async () => {
    mockGetGithubSetupStatus.mockResolvedValue({
      created: false,
      source: 'env',
      installationReady: true,
    });

    await renderAutomations();

    expect(container.textContent).toContain(
      'GitHub App: configured by environment',
    );
    expect(findButton('Create the Zaplie GitHub App')).toBeUndefined();
    expect(findButton('Connect repositories')?.disabled).toBe(false);
  });

  test('a partial env configuration keeps repositories blocked', async () => {
    // Say GITHUB_APP_SLUG alone: the server reports source env, but listing
    // the installation's repositories would need the App key.
    mockGetGithubSetupStatus.mockResolvedValue({
      created: false,
      source: 'env',
      installationReady: false,
    });

    await renderAutomations();

    expect(container.textContent).toContain(
      'GitHub App: environment configuration is incomplete',
    );
    expect(container.textContent).not.toContain('configured by environment');
    expect(findButton('Connect repositories')?.disabled).toBe(true);
    expect(findButton('Create the Zaplie GitHub App')).toBeDefined();
  });

  test('an unreadable env key file offers no creation, only the override', async () => {
    // Env wins over the store, so an App created now would not be used.
    mockGetGithubSetupStatus.mockResolvedValue({
      created: false,
      source: 'env',
      installationReady: false,
      envKeyUnreadable: true,
    });

    await renderAutomations();

    expect(container.textContent).toContain(
      'GITHUB_APP_PRIVATE_KEY_PATH cannot be read',
    );
    expect(container.textContent).not.toContain('configuration is incomplete');
    expect(findButton('Connect repositories')?.disabled).toBe(true);
    expect(findButton('Create the Zaplie GitHub App')).toBeUndefined();
  });

  test('a non-admin sees no setup block', async () => {
    mockIsAdmin.mockReturnValue(false);

    await renderAutomations();

    expect(mockGetGithubSetupStatus).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('App created');
    expect(container.textContent).not.toContain('GitHub App: not created');
    expect(findButton('Create the Zaplie GitHub App')).toBeUndefined();
  });

  test('?setup=github_created toasts once and is stripped from the URL', async () => {
    window.history.replaceState(
      {},
      '',
      '/automations?setup=github_created&tab=rules',
    );

    await renderAutomations();

    expect(mockToastSuccess).toHaveBeenCalledWith(
      'GitHub App created. You can connect repositories now.',
    );
    expect(window.location.search).toBe('?tab=rules');
  });

  test('?setup=github_error toasts an error and is stripped from the URL', async () => {
    window.history.replaceState({}, '', '/automations?setup=github_error');

    await renderAutomations();

    expect(mockToastError).toHaveBeenCalledWith(
      'Creating the GitHub App failed. Please try again.',
    );
    expect(window.location.search).toBe('');
  });
});
