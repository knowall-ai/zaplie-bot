import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import DirectoryAdminSetting from './DirectoryAdminSetting';

const mockIsZaplieAdmin = jest.fn();
const mockList = jest.fn();
const mockLink = jest.fn();
const mockProvision = jest.fn();
const mockToastSuccess = jest.fn();

jest.mock('@azure/msal-react', () => ({
  useMsal: () => ({ accounts: [{}] }),
}));

jest.mock('../services/adminRole', () => ({
  isZaplieAdmin: () => mockIsZaplieAdmin(),
}));

jest.mock('../services/directory', () => ({
  listDirectoryPeople: () => mockList(),
  linkAllowanceWallet: (oid: string, link: unknown) => mockLink(oid, link),
  provisionPeople: (request: unknown) => mockProvision(request),
}));

jest.mock('react-toastify', () => ({
  toast: { success: (...args: unknown[]) => mockToastSuccess(...args) },
}));

const OID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const person = {
  oid: OID,
  displayName: 'Ada',
  email: '',
  allowanceWalletId: null,
  allowanceSource: null,
  allowanceLightningAddress: null,
  receive: { lightningAddress: null },
};

let container: HTMLDivElement;
let root: Root;

const settle = async () => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const mount = () => {
  root.render(<DirectoryAdminSetting />);
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
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const setValue = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value);
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

const TOKEN = 'lnbits-acl-token-short-lived-0123456789';
const NWC = `nostr+walletconnect://${'b'.repeat(64)}?relay=wss%3A%2F%2Fbank.example&secret=${'c'.repeat(64)}`;

const openDialog = async () => {
  await act(async () => {
    button('Add people').click();
  });
};

describe('DirectoryAdminSetting', () => {
  test('renders nothing, and reads nothing, for a non-admin', async () => {
    mockIsZaplieAdmin.mockReturnValue(false);

    await render();

    expect(container.innerHTML).toBe('');
    expect(mockList).not.toHaveBeenCalled();
  });

  test('provisioner mode sends the pending people, budget and token once, then forgets the token', async () => {
    mockIsZaplieAdmin.mockReturnValue(true);
    mockList.mockResolvedValue({ provisioners: ['lnbits'], people: [person] });
    mockProvision.mockResolvedValue({
      results: [
        {
          oid: OID,
          displayName: 'Ada',
          status: 'provisioned',
          lightningAddress: 'zaplie-0f8fad5bd9cb@bank.example',
        },
      ],
    });

    await render();
    await openDialog();
    expect(
      container.querySelector('[data-testid="provisioner-mode"]'),
    ).not.toBe(null);
    await setInput('provision-token', TOKEN);
    await setInput('provision-budget', '30000');
    await act(async () => {
      button('Create wallets').click();
    });
    await settle();

    expect(mockProvision).toHaveBeenCalledWith({
      provisioner: 'lnbits',
      token: TOKEN,
      people: [{ oid: OID, displayName: 'Ada' }],
      budgetSats: 30000,
      period: 'weekly',
    });
    expect(
      container.querySelector<HTMLInputElement>('#provision-token')!.value,
    ).toBe('');
    expect(container.textContent).toContain('zaplie-0f8fad5bd9cb@bank.example');
    expect(container.textContent).not.toContain(TOKEN);
  });

  test('a failed person is reported with the backend message', async () => {
    mockIsZaplieAdmin.mockReturnValue(true);
    mockList.mockResolvedValue({ provisioners: ['lnbits'], people: [person] });
    mockProvision.mockResolvedValue({
      results: [
        {
          oid: OID,
          displayName: 'Ada',
          status: 'failed',
          message:
            'Creating the wallet: LNbits refused the token (expired, or missing that permission)',
        },
      ],
    });

    await render();
    await openDialog();
    await setInput('provision-token', TOKEN);
    await act(async () => {
      button('Create wallets').click();
    });
    await settle();

    const row = container.querySelector('[data-status="failed"]');
    expect(row?.textContent).toContain('LNbits refused the token');
  });

  test('manual mode links each pasted NWC connection and clears it', async () => {
    mockIsZaplieAdmin.mockReturnValue(true);
    mockList.mockResolvedValue({ provisioners: [], people: [person] });
    mockLink.mockResolvedValue({
      person: {
        ...person,
        allowanceLightningAddress: 'zaplie-ada@bank.example',
      },
      balanceSats: 0,
    });

    await render();
    await openDialog();
    // Without a provisioner only the manual mode is offered.
    expect(container.querySelector('[data-testid="manual-mode"]')).not.toBe(
      null,
    );
    const nwcInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="NWC connection for Ada"]',
    )!;
    const addressInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="Lightning address for Ada"]',
    )!;
    await setValue(nwcInput, NWC);
    await setValue(addressInput, 'zaplie-ada@bank.example');
    await act(async () => {
      button('Link wallets').click();
    });
    await settle();

    expect(mockLink).toHaveBeenCalledWith(OID, {
      nwcUrl: NWC,
      lightningAddress: 'zaplie-ada@bank.example',
      displayName: 'Ada',
    });
    expect(
      container.querySelector('[data-status="provisioned"]')?.textContent,
    ).toContain('zaplie-ada@bank.example');
    expect(container.textContent).not.toContain('c'.repeat(64));
  });

  test('someone who has not signed in yet can be added by Entra object id', async () => {
    mockIsZaplieAdmin.mockReturnValue(true);
    mockList.mockResolvedValue({ provisioners: ['lnbits'], people: [] });
    mockProvision.mockResolvedValue({ results: [] });
    const NEW = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

    await render();
    await openDialog();
    await setValue(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="Entra object id"]',
      )!,
      NEW,
    );
    await setValue(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="Display name"]',
      )!,
      'Bea',
    );
    await act(async () => {
      button('Add to list').click();
    });
    await setInput('provision-token', TOKEN);
    await act(async () => {
      button('Create wallets').click();
    });
    await settle();

    expect(mockProvision).toHaveBeenCalledWith(
      expect.objectContaining({ people: [{ oid: NEW, displayName: 'Bea' }] }),
    );
  });
});
