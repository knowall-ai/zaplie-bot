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
import { bech32 } from '@scure/base';
import SendPayment from './SendPayment';
import { INVOICE_ERRORS } from '../utils/lightningInvoice';

// The QR scanner reaches for camera APIs jsdom has no answer for, and no case
// here scans. payInvoice is stubbed so no test can reach the network.
jest.mock('@yudiel/react-qr-scanner', () => ({
  Scanner: () => null,
}));

jest.mock('../services/wallet/payments', () => ({
  payInvoice: () => Promise.resolve({ payment_hash: 'hash' }),
}));

// A real, checksum-valid mainnet invoice from the BOLT11 test vectors. Its
// data words are re-encoded under different prefixes below, so every case is
// an invoice the decoder genuinely accepts rather than a hand-written string
// it would reject on the checksum before any of our guards run.
const BASE_INVOICE =
  'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp';
const BASE_WORDS = bech32.decode(BASE_INVOICE, Infinity as never).words;
const invoiceWithPrefix = (prefix: string): string =>
  bech32.encode(prefix, BASE_WORDS, Infinity as never);

const currentUser = {
  privateWallet: { id: 'wallet-1' },
} as unknown as User;

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function mountSendPayment(): void {
  root.render(
    <SendPayment onClose={() => {}} currentUserLNbitDetails={currentUser} />,
  );
}

const mount = async () => {
  await act(async () => {
    mountSendPayment();
  });
};

const textarea = () =>
  container.querySelector('textarea') as HTMLTextAreaElement;

const sendButton = () =>
  Array.from(container.querySelectorAll('button')).find(
    button => button.textContent === 'Send',
  ) as HTMLButtonElement;

const alertText = () =>
  container.querySelector('[role="alert"]')?.textContent ?? null;

const readOnlyAmount = () =>
  (
    container.querySelector(
      'input[aria-label="Invoice amount"]',
    ) as HTMLInputElement | null
  )?.value ?? null;

const typeInvoice = async (value: string) => {
  const field = textarea();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

describe('SendPayment invoice entry', () => {
  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await mount();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  test('arms Send and shows the amount for a payable invoice', async () => {
    expect(sendButton().disabled).toBe(true);

    await typeInvoice(invoiceWithPrefix('lnbc20m'));

    expect(sendButton().disabled).toBe(false);
    expect(alertText()).toBeNull();
    // The unit sits with the amount, not inside the note.
    expect(readOnlyAmount()).toBe('2000000 sats. Note: 1 cup coffee');
  });

  test('strips a lightning: prefix before decoding', async () => {
    await typeInvoice(`lightning:${invoiceWithPrefix('lnbc20m')}`);

    expect(sendButton().disabled).toBe(false);
    expect(readOnlyAmount()).toContain('2000000');
  });

  test('keeps Send disabled and explains an amountless invoice', async () => {
    await typeInvoice(invoiceWithPrefix('lnbc'));

    expect(sendButton().disabled).toBe(true);
    expect(alertText()).toBe(INVOICE_ERRORS.missingAmount);
  });

  // The regression this guard exists for: the pico-BTC multiplier encodes a
  // tenth of a sat, which a bare `/ 1000` rendered as '967878.534'.
  test('keeps Send disabled for a sub-satoshi invoice', async () => {
    await typeInvoice(invoiceWithPrefix('lnbc9678785340p'));

    expect(sendButton().disabled).toBe(true);
    expect(alertText()).toBe(INVOICE_ERRORS.subSatoshiAmount);
  });

  test('shows the generic message rather than raw decoder text', async () => {
    await typeInvoice('lnbc1');

    expect(sendButton().disabled).toBe(true);
    expect(alertText()).toBe(INVOICE_ERRORS.undecodable);
    expect(alertText()).not.toMatch(/Wrong string length/i);
  });

  test('clearing the box drops the previous amount, note and error', async () => {
    await typeInvoice(invoiceWithPrefix('lnbc20m'));
    expect(readOnlyAmount()).toContain('2000000');

    await typeInvoice('');

    expect(sendButton().disabled).toBe(true);
    expect(readOnlyAmount()).toBeNull();
    expect(alertText()).toBeNull();
  });
});
