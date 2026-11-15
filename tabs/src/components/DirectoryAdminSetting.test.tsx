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
  linkAllowanceWallet: (oid: string, keys: unknown) => mockLink(oid, keys),
  provisionAllowanceWallet: (oid: string) => mockProvision(oid),
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
  receive: { lightningAddress: null, invoiceKeyRegistered: false },
};

let container: HTMLDivElement;
let root: Root;

const settle = async () => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const render = async () => {
  await act(async () => {
    root.render(<DirectoryAdminSetting />);
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

describe('DirectoryAdminSetting', () => {
  test('renders nothing, and reads nothing, for a non-admin', async () => {
    mockIsZaplieAdmin.mockReturnValue(false);

    await render();

    expect(container.innerHTML).toBe('');
    expect(mockList).not.toHaveBeenCalled();
  });

  test('links pasted keys for the chosen person and clears them', async () => {
    mockIsZaplieAdmin.mockReturnValue(true);
    mockList.mockResolvedValue({ provisioning: 'operator', people: [person] });
    mockLink.mockResolvedValue({ person, ownershipVerified: false });

    await render();
    await act(async () => {
      button('Link…').click();
    });
    await setInput('link-adminkey', 'a'.repeat(32));
    await setInput('link-inkey', 'b'.repeat(32));
    await act(async () => {
      button('Link wallet').click();
    });
    await settle();

    expect(mockLink).toHaveBeenCalledWith(OID, {
      adminkey: 'a'.repeat(32),
      inkey: 'b'.repeat(32),
      displayName: 'Ada',
    });
    expect(
      container.querySelector<HTMLInputElement>('#link-adminkey')!.value,
    ).toBe('');
    expect(mockToastSuccess).toHaveBeenCalledWith(
      expect.stringContaining('could not confirm'),
    );
  });

  test('creates the wallet directly when the API token is configured', async () => {
    mockIsZaplieAdmin.mockReturnValue(true);
    mockList.mockResolvedValue({ provisioning: 'automatic', people: [person] });
    mockProvision.mockResolvedValue({ person });

    await render();
    await act(async () => {
      button('Create').click();
    });
    await settle();

    expect(mockProvision).toHaveBeenCalledWith(OID);
  });
});
