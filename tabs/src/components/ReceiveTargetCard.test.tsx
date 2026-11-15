import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import ReceiveTargetCard from './ReceiveTargetCard';

const mockGetMyDirectoryEntry = jest.fn();
const mockSetMyReceiveAddress = jest.fn();
const mockToastSuccess = jest.fn();

jest.mock('../services/directory', () => ({
  getMyDirectoryEntry: () => mockGetMyDirectoryEntry(),
  setMyReceiveAddress: (address: unknown) => mockSetMyReceiveAddress(address),
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
  allowanceLightningAddress: 'zaplie-0f8fad5bd9cb@bank.example',
  receive: { lightningAddress: null },
  allowanceSats: 2100,
  budget: null,
  ...overrides,
});

let container: HTMLDivElement;
let root: Root;

const settle = async () => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const mount = () => {
  root.render(<ReceiveTargetCard />);
};

const render = async () => {
  await act(async () => {
    mount();
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

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

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
    ).toMatch(/not set up/i);
    expect(container.querySelector('[role="note"]')?.textContent).toContain(
      "Colleagues can't zap you yet",
    );
    expect(
      container.querySelector('[data-testid="allowance-status"]')?.textContent,
    ).toContain('2,100 sats');
    expect(container.querySelector('[data-testid="allowance-budget"]')).toBe(
      null,
    );
    // There is no invoice-key path any more: an address is the only target.
    expect(container.querySelector('#receive-invoice-key')).toBe(null);
  });

  test("the placeholder shows this deployment's address format", async () => {
    mockGetMyDirectoryEntry.mockResolvedValue(
      entry({ receiveDomains: ['bank.knowall.ai'] }),
    );

    await render();

    const input =
      container.querySelector<HTMLInputElement>('#receive-address')!;
    expect(input.placeholder).toBe('name@bank.knowall.ai');
    expect(input.getAttribute('aria-describedby')).toBe('receive-address-help');
    expect(container.textContent).toContain(
      'Accepted here: name@bank.knowall.ai.',
    );
  });

  test('saves a Lightning address and reloads', async () => {
    mockGetMyDirectoryEntry
      .mockResolvedValueOnce(entry())
      .mockResolvedValueOnce(
        entry({ receive: { lightningAddress: 'ada@bank.example' } }),
      );
    mockSetMyReceiveAddress.mockResolvedValue({});

    await render();
    await setInput('receive-address', ' ada@bank.example ');
    await act(async () => {
      button('Save').click();
    });
    await settle();

    expect(mockSetMyReceiveAddress).toHaveBeenCalledWith('ada@bank.example');
    expect(
      container.querySelector('[data-testid="receive-status"]')?.textContent,
    ).toContain('ada@bank.example');
  });

  test('shows why an address is refused', async () => {
    mockGetMyDirectoryEntry.mockResolvedValue(entry());
    mockSetMyReceiveAddress.mockRejectedValue(
      new Error(
        'Lightning addresses on wallet.other are not accepted here. Allowed: bank.example.',
      ),
    );

    await render();
    await setInput('receive-address', 'ada@wallet.other');
    await act(async () => {
      button('Save').click();
    });
    await settle();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'not accepted here',
    );
  });

  test('removes a registered address', async () => {
    mockGetMyDirectoryEntry.mockResolvedValue(
      entry({ receive: { lightningAddress: 'ada@bank.example' } }),
    );
    mockSetMyReceiveAddress.mockResolvedValue({});

    await render();
    await act(async () => {
      button('Remove').click();
    });
    await settle();

    expect(mockSetMyReceiveAddress).toHaveBeenCalledWith(null);
  });

  test('shows what is left to send when the wallet reports a budget', async () => {
    mockGetMyDirectoryEntry.mockResolvedValue(
      entry({
        budget: {
          totalSats: 10000,
          usedSats: 2500,
          renewsAt: null,
          renewalPeriod: 'weekly',
        },
      }),
    );

    await render();

    expect(
      container.querySelector('[data-testid="allowance-budget"]')?.textContent,
    ).toContain('7,500 sats');
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
