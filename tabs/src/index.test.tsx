import React from 'react';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';

jest.mock('./App', () => ({
  __esModule: true,
  default: () => <div data-testid="app">Zaplie</div>,
}));

jest.mock('@azure/msal-react', () => ({
  MsalProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

// react-router-dom v7's ESM entry does not resolve under CRA's Jest config,
// and the router is irrelevant to the startup sequence under test.
jest.mock('react-router-dom', () => ({
  BrowserRouter: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

jest.mock('./services/msalClient', () => ({
  getMsalInstance: require('@jest/globals').jest.fn(),
}));

const getMsalInstance = () =>
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  jest.mocked(require('./services/msalClient').getMsalInstance);

const makeInstance = (overrides: Record<string, unknown> = {}) => ({
  initialize: jest.fn(async () => undefined),
  handleRedirectPromise: jest.fn(async () => null),
  getAllAccounts: jest.fn(() => []),
  getActiveAccount: jest.fn(() => null),
  setActiveAccount: jest.fn(),
  addEventCallback: jest.fn(),
  ...overrides,
});

const makeConsoleErrorSpy = () =>
  jest.fn<void, [message?: unknown, ...rest: unknown[]]>();

describe('index startup sequence', () => {
  let root: HTMLDivElement;
  let consoleError: ReturnType<typeof makeConsoleErrorSpy>;
  let originalConsoleError: typeof console.error;

  beforeEach(() => {
    // No act() here: jest.resetModules() gives ./index its own React copy, so
    // this file's act() would flush a different renderer's queue.
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = false;
    jest.resetModules();
    root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);
    consoleError = makeConsoleErrorSpy();
    originalConsoleError = console.error;
    console.error = consoleError as unknown as typeof console.error;
  });

  afterEach(() => {
    console.error = originalConsoleError;
    root.remove();
  });

  const bootstrap = async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    await (require('./index') as { startupComplete: Promise<void> })
      .startupComplete;
    // Let the concurrent root commit before asserting on the DOM.
    await new Promise(resolve => setTimeout(resolve, 0));
  };

  test('renders the app when startup succeeds', async () => {
    getMsalInstance().mockReturnValue(makeInstance());

    await bootstrap();

    expect(root.textContent).toContain('Zaplie');
    expect(root.textContent).not.toContain('could not start');
  });

  test('shows the startup error, naming the missing configuration, when initialize rejects', async () => {
    getMsalInstance().mockImplementation(() => {
      throw new Error('REACT_APP_AAD_CLIENT_ID is required.');
    });

    await bootstrap();

    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      'Zaplie could not start',
    );
    expect(root.textContent).toContain('REACT_APP_AAD_CLIENT_ID is required.');
    expect(consoleError).toHaveBeenCalledWith(
      'Zaplie startup failed',
      expect.any(Error),
    );
  });

  test('still renders the app when the redirect promise rejects', async () => {
    // Declining consent rejects here. AuthEnd has to mount so it can notify
    // Teams; a startup error would leave the Teams popup hanging.
    getMsalInstance().mockReturnValue(
      makeInstance({
        handleRedirectPromise: jest.fn(async () => {
          throw new Error('access_denied');
        }),
      }),
    );

    await bootstrap();

    expect(root.textContent).toContain('Zaplie');
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(consoleError).toHaveBeenCalledWith(
      'Zaplie could not complete the sign-in redirect',
      expect.any(Error),
    );
  });
});
