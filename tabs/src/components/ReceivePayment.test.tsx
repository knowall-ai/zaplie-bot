import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import ReceivePayment, {
  PAYMENT_POLL_DELAY_MS,
} from './ReceivePayment';
import { createInvoice, getWalletPayments } from '../services/lnbits/payments';

jest.mock('../services/lnbits/payments', () => ({
  createInvoice: jest.fn(),
  getWalletPayments: jest.fn(),
}));

jest.mock('../services/lnbits/wallets', () => ({
  getWalletBalance: jest.fn(),
}));

const mockCreateInvoice = createInvoice as jest.MockedFunction<
  typeof createInvoice
>;
const mockGetWalletPayments = getWalletPayments as jest.MockedFunction<
  typeof getWalletPayments
>;
const currentUser = {
  privateWallet: { id: 'wallet-1' },
} as unknown as User;

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('ReceivePayment polling lifecycle', () => {
  let container: HTMLDivElement;
  let root: Root;
  let didUnmount: boolean;

  beforeEach(() => {
    jest.useFakeTimers();
    mockCreateInvoice.mockReset();
    mockGetWalletPayments.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    didUnmount = false;
  });

  afterEach(async () => {
    if (!didUnmount) {
      await act(async () => {
        root.unmount();
      });
    }
    container.remove();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  const enterInvoiceDetails = async () => {
    const amount = container.querySelector(
      '[data-testid="receive-amount"]',
    ) as HTMLInputElement;
    const note = container.querySelector(
      '[data-testid="receive-note"]',
    ) as HTMLTextAreaElement;

    await act(async () => {
      const setAmount = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      setAmount?.call(amount, '100');
      amount.dispatchEvent(new Event('change', { bubbles: true }));

      const setNote = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      setNote?.call(note, 'Thanks');
      note.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await act(async () => {
      (
        container.querySelector(
          '[data-testid="receive-next"]',
        ) as HTMLButtonElement
      ).click();
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  test('clears the active poll when the component unmounts', async () => {
    const setTimeoutSpy = jest.spyOn(window, 'setTimeout');
    const clearTimeoutSpy = jest.spyOn(window, 'clearTimeout');
    mockCreateInvoice.mockResolvedValue('invoice');
    mockGetWalletPayments.mockResolvedValue([]);

    // Raw createRoot requires render work to be wrapped in act.
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      root.render(
        <ReceivePayment
          onClose={() => {}}
          currentUserLNbitDetails={currentUser}
        />,
      );
    });
    await enterInvoiceDetails();

    expect(mockCreateInvoice).toHaveBeenCalledTimes(1);
    const paymentCheckTimerIndex = setTimeoutSpy.mock.calls.findIndex(
      call => call[1] === PAYMENT_POLL_DELAY_MS,
    );
    expect(paymentCheckTimerIndex).not.toBe(-1);
    const paymentCheckTimer =
      setTimeoutSpy.mock.results[paymentCheckTimerIndex].value;

    // Raw createRoot requires unmount work to be wrapped in act.
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      root.unmount();
    });
    didUnmount = true;
    expect(clearTimeoutSpy).toHaveBeenCalledWith(paymentCheckTimer);
    await act(async () => {
      jest.advanceTimersByTime(PAYMENT_POLL_DELAY_MS);
    });

    expect(mockGetWalletPayments).not.toHaveBeenCalled();
  });

  test('does not start polling if invoice creation resolves after unmount', async () => {
    let resolveInvoice!: (invoice: string) => void;
    mockCreateInvoice.mockReturnValue(
      new Promise(resolve => {
        resolveInvoice = resolve;
      }),
    );

    // Raw createRoot requires render work to be wrapped in act.
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      root.render(
        <ReceivePayment
          onClose={() => {}}
          currentUserLNbitDetails={currentUser}
        />,
      );
    });
    await enterInvoiceDetails();

    // Raw createRoot requires unmount work to be wrapped in act.
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      root.unmount();
    });
    didUnmount = true;
    await act(async () => {
      resolveInvoice('invoice');
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      jest.advanceTimersByTime(PAYMENT_POLL_DELAY_MS);
    });

    expect(mockGetWalletPayments).not.toHaveBeenCalled();
  });

  test('disables Next after opening the invoice dialog', async () => {
    mockCreateInvoice.mockReturnValue(new Promise(() => {}));

    // Raw createRoot requires render work to be wrapped in act.
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      root.render(
        <ReceivePayment
          onClose={() => {}}
          currentUserLNbitDetails={currentUser}
        />,
      );
    });
    await enterInvoiceDetails();

    const nextButton = container.querySelector(
      '[data-testid="receive-next"]',
    );
    expect(nextButton).toBeDefined();
    expect(nextButton).toHaveProperty('disabled', true);
    expect(mockCreateInvoice).toHaveBeenCalledTimes(1);
  });

  test('does not overlap payment checks when a request is still pending', async () => {
    let resolvePayments!: (payments: Transaction[]) => void;
    mockCreateInvoice.mockResolvedValue('invoice');
    mockGetWalletPayments
      .mockReturnValueOnce(
        new Promise(resolve => {
          resolvePayments = resolve;
        }),
      )
      .mockResolvedValue([]);

    // Raw createRoot requires render work to be wrapped in act.
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      root.render(
        <ReceivePayment
          onClose={() => {}}
          currentUserLNbitDetails={currentUser}
        />,
      );
    });
    await enterInvoiceDetails();

    await act(async () => {
      jest.advanceTimersByTime(PAYMENT_POLL_DELAY_MS * 3);
    });
    expect(mockGetWalletPayments).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePayments([]);
      await Promise.resolve();
    });
    await act(async () => {
      jest.advanceTimersByTime(PAYMENT_POLL_DELAY_MS);
    });
    expect(mockGetWalletPayments).toHaveBeenCalledTimes(2);
  });

  test('does not schedule another check when a pending request resolves after unmount', async () => {
    const setTimeoutSpy = jest.spyOn(window, 'setTimeout');
    let resolvePayments!: (payments: Transaction[]) => void;
    mockCreateInvoice.mockResolvedValue('invoice');
    mockGetWalletPayments.mockReturnValue(
      new Promise(resolve => {
        resolvePayments = resolve;
      }),
    );

    // Raw createRoot requires render work to be wrapped in act.
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      root.render(
        <ReceivePayment
          onClose={() => {}}
          currentUserLNbitDetails={currentUser}
        />,
      );
    });
    await enterInvoiceDetails();
    await act(async () => {
      jest.advanceTimersByTime(PAYMENT_POLL_DELAY_MS);
    });
    expect(mockGetWalletPayments).toHaveBeenCalledTimes(1);

    // Raw createRoot requires unmount work to be wrapped in act.
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      root.unmount();
    });
    didUnmount = true;

    await act(async () => {
      resolvePayments([]);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      jest.advanceTimersByTime(PAYMENT_POLL_DELAY_MS * 3);
    });

    expect(mockGetWalletPayments).toHaveBeenCalledTimes(1);
    expect(
      setTimeoutSpy.mock.calls.filter(
        call => call[1] === PAYMENT_POLL_DELAY_MS,
      ),
    ).toHaveLength(1);
  });
});
