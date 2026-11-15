import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import ReceiveTargetCard from './ReceiveTargetCard';

const mockGetMyDirectoryEntry = jest.fn();
const mockSetMyReceiveTarget = jest.fn();
const mockToastSuccess = jest.fn();

jest.mock('../services/directory', () => ({
  getMyDirectoryEntry: () => mockGetMyDirectoryEntry(),
  setMyReceiveTarget: (target: unknown) => mockSetMyReceiveTarget(target),
}));

jest.mock('react-toastify', () => ({
  toast: { success: (...args: unknown[]) => mockToastSuccess(...args) },
}));

const entry = (overrides: Record<string, unknown> = {}) => ({
  oid: '0f8fad5b-d9cb-469f-a165-70867728950e',
  displayName: 'Ada',
  email: '',
  allowanceWalletId: 'w-1',
  allowanceSource: 'token',
  receive: { lightningAddress: null, invoiceKeyRegistered: false },
  allowanceSats: 2100,
  privateSats: null,
  provisioning: 'automatic',
  ...overrides,
});

let container: HTMLDivElement;
let root: Root;

const settle = async () => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const render = async () => {
  await act(async () => {
    root.render(<ReceiveTargetCard />);
  });
  await settle();
};

const setInput = async (id: string, value: string) => {
  const input = container.querySelector<HTMLInputElement>(`#${id}`)!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const button = (label: string) =>
  Array.from(container.querySelectorAll('button')).find(
    candidate => candidate.textContent === label,
  )!;

beforeEach(() => {
  jest.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ReceiveTargetCard', () => {
  test('says when nobody can zap the person yet', async () => {
    mockGetMyDirectoryEntry.mockResolvedValue(entry());

    await render();

    expect(
      container.querySelector('[data-testid="receive-status"]')?.textContent,
    ).toContain('not set up');
    expect(
      container.querySelector('[data-testid="allowance-status"]')?.textContent,
    ).toContain('2,100 sats');
    expect(container.querySelector('[data-testid="private-balance"]')).toBe(
      null,
    );
  });

  test('saves a Lightning address and reloads', async () => {
    mockGetMyDirectoryEntry
      .mockResolvedValueOnce(entry())
      .mockResolvedValueOnce(
        entry({
          receive: {
            lightningAddress: 'ada@bank.example',
            invoiceKeyRegistered: false,
          },
        }),
      );
    mockSetMyReceiveTarget.mockResolvedValue({});

    await render();
    await setInput('receive-address', ' ada@bank.example ');
    await act(async () => {
      button('Save').click();
    });
    await settle();

    expect(mockSetMyReceiveTarget).toHaveBeenCalledWith({
      lightningAddress: 'ada@bank.example',
    });
    expect(
      container.querySelector('[data-testid="receive-status"]')?.textContent,
    ).toContain('ada@bank.example');
  });

  test('shows the backend refusal and never echoes the key', async () => {
    mockGetMyDirectoryEntry.mockResolvedValue(entry());
    mockSetMyReceiveTarget.mockRejectedValue(
      new Error('that is an admin key; paste the invoice (read) key instead'),
    );

    await render();
    await setInput('receive-invoice-key', 'a'.repeat(32));
    await act(async () => {
      button('Save key').click();
    });
    await settle();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'admin key',
    );
    expect(container.textContent).not.toContain('a'.repeat(32));
  });

  test('shows the Private balance when an invoice key is registered', async () => {
    mockGetMyDirectoryEntry.mockResolvedValue(
      entry({
        receive: { lightningAddress: null, invoiceKeyRegistered: true },
        privateSats: 500,
      }),
    );

    await render();

    expect(
      container.querySelector('[data-testid="private-balance"]')?.textContent,
    ).toContain('500 sats');
  });

  test('explains when the person is not in the directory yet', async () => {
    mockGetMyDirectoryEntry.mockRejectedValue(
      new Error('No Zaplie wallet is linked to this account'),
    );

    await render();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'not set up in Zaplie yet',
    );
  });
});
