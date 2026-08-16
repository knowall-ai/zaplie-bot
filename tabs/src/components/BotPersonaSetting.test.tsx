// Rendered with react-dom + act instead of @testing-library/react, which is
// not a dependency of this package; keeps the lockfile untouched.
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { useMsal } from '@azure/msal-react';
import { toast } from 'react-toastify';
import { getBotPersona, updateBotPersona } from '../apiService';
import { acquireIdToken } from '../services/adminRole';
import BotPersonaSetting from './BotPersonaSetting';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

jest.mock('@azure/msal-react', () => ({ useMsal: jest.fn() }));
jest.mock('../apiService', () => ({
  getBotPersona: jest.fn(),
  updateBotPersona: jest.fn(),
}));
jest.mock('../services/adminRole', () => ({
  acquireIdToken: jest.fn(),
  isZaplieAdmin: (
    account: { idTokenClaims?: { roles?: string[] } } | undefined,
  ) => account?.idTokenClaims?.roles?.includes('Zaplie.Admin') === true,
}));
jest.mock('react-toastify', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const mockUseMsal = useMsal as jest.MockedFunction<typeof useMsal>;
const mockGetBotPersona = getBotPersona as jest.MockedFunction<
  typeof getBotPersona
>;
const mockUpdateBotPersona = updateBotPersona as jest.MockedFunction<
  typeof updateBotPersona
>;
const mockAcquireIdToken = acquireIdToken as jest.MockedFunction<
  typeof acquireIdToken
>;

const msalWithRoles = (roles: string[]) =>
  ({
    instance: {},
    accounts: [{ homeAccountId: 'account-1', idTokenClaims: { roles } }],
    inProgress: 'none',
    logger: {},
  }) as unknown as ReturnType<typeof useMsal>;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  jest.clearAllMocks();
  mockUseMsal.mockReturnValue(msalWithRoles(['Zaplie.Admin']));
  mockAcquireIdToken.mockResolvedValue('fresh-id-token');
  mockGetBotPersona.mockResolvedValue({ botPersona: 'Be concise.' });
  mockUpdateBotPersona.mockImplementation(async (_token, botPersona) => ({
    botPersona,
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const renderSetting = () =>
  act(async () => {
    root.render(<BotPersonaSetting />);
  });

const textarea = () =>
  container.querySelector('textarea#bot-persona') as HTMLTextAreaElement;

// React ignores a direct .value assignment (its value tracker sees no change),
// so go through the native setter before dispatching the input event.
const typePersona = (value: string) =>
  act(async () => {
    const element = textarea();
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )!.set!;
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });

const submitForm = () =>
  act(async () => {
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });

test('renders nothing and fetches nothing for a non-admin', async () => {
  mockUseMsal.mockReturnValue(msalWithRoles([]));

  await renderSetting();

  expect(container.innerHTML).toBe('');
  expect(mockAcquireIdToken).not.toHaveBeenCalled();
  expect(mockGetBotPersona).not.toHaveBeenCalled();
});

test('loads the stored persona into the editor with a single Save button', async () => {
  await renderSetting();

  expect(textarea().value).toBe('Be concise.');
  expect(textarea().disabled).toBe(false);
  const buttons = container.querySelectorAll('button');
  expect(buttons).toHaveLength(1);
  expect(buttons[0].textContent).toBe('Save');
});

test('saves the trimmed persona with a fresh token and keeps the server value', async () => {
  await renderSetting();
  await typePersona('  Celebrate specific work.  ');

  await submitForm();

  expect(mockUpdateBotPersona).toHaveBeenCalledWith(
    'fresh-id-token',
    'Celebrate specific work.',
  );
  expect(textarea().value).toBe('Celebrate specific work.');
  expect(toast.success).toHaveBeenCalledWith('Bot personality saved.');
});

test('a failed load disables the editor and says so instead of offering a blind overwrite', async () => {
  mockGetBotPersona.mockRejectedValue(new Error('backend down'));
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

  await renderSetting();

  expect(container.textContent).toContain(
    'Unable to load the current bot personality.',
  );
  expect(textarea().disabled).toBe(true);
  expect(container.querySelector('button')!.disabled).toBe(true);
  consoleError.mockRestore();
});

test('a failed save surfaces an error toast and keeps the draft editable', async () => {
  mockUpdateBotPersona.mockRejectedValue(new Error('backend down'));
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  await renderSetting();
  await typePersona('New persona.');

  await submitForm();

  expect(toast.error).toHaveBeenCalledWith(
    'Unable to save the bot personality.',
  );
  expect(textarea().value).toBe('New persona.');
  expect(container.querySelector('button')!.disabled).toBe(false);
  consoleError.mockRestore();
});
