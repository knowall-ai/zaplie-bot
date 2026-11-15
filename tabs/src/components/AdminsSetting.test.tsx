import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import AdminsSetting from './AdminsSetting';

const mockIsZaplieAdmin = jest.fn();
const mockGetTenantMe = jest.fn();
const mockList = jest.fn();
const mockCanManage = jest.fn();
const mockAdd = jest.fn();
const mockRemove = jest.fn();

jest.mock('@azure/msal-react', () => ({ useMsal: () => ({ accounts: [{}] }) }));
jest.mock('../services/adminRole', () => ({
  isZaplieAdmin: () => mockIsZaplieAdmin(),
}));
jest.mock('../services/tenant', () => ({
  getTenantMe: () => mockGetTenantMe(),
  groupMembersLink: (id: string) => `https://entra.example/groups/${id}`,
  enterpriseAppUsersLink: () => 'https://entra.example/app',
}));
jest.mock('../services/graphAdmins', () => {
  class GraphPermissionMissingError extends Error {}
  return {
    GraphPermissionMissingError,
    listGroupMembers: (id: string) => mockList(id),
    canManageMembers: () => mockCanManage(),
    addGroupMember: (id: string, upn: string) => mockAdd(id, upn),
    removeGroupMember: (id: string, member: string) => mockRemove(id, member),
  };
});

const GROUP = 'abcdef01-2345-4678-9abc-def012345678';
const tenant = (adminsGroupId: string | null) => ({
  tid: 't',
  isHomeTenant: true,
  actingAsPlatform: false,
  roles: { zaplieAdmin: true, setupAdmin: true, platformOperator: false },
  clientId: 'c',
  settings: {
    adminsGroupId,
    guestAllowlist: [],
    provisioner: { defaultBudgetSats: 25000, defaultPeriod: 'weekly' },
  },
});

let container: HTMLDivElement;
let root: Root;
const settle = async () => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};
const mount = () => {
  root.render(<AdminsSetting />);
};
const render = async () => {
  await act(async () => {
    mount();
  });
  await settle();
};

beforeEach(() => {
  jest.clearAllMocks();
  mockIsZaplieAdmin.mockReturnValue(true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('AdminsSetting', () => {
  test('without a group it points to the setup page', async () => {
    mockGetTenantMe.mockResolvedValue(tenant(null));
    await render();
    expect(container.querySelector('[data-testid="admins-no-group"]')).not.toBe(
      null,
    );
    expect(mockList).not.toHaveBeenCalled();
  });

  test('without GroupMember.Read.All it explains and links to Entra', async () => {
    const { GraphPermissionMissingError } = jest.requireMock(
      '../services/graphAdmins',
    ) as {
      GraphPermissionMissingError: new () => Error;
    };
    mockGetTenantMe.mockResolvedValue(tenant(GROUP));
    mockList.mockRejectedValue(new GraphPermissionMissingError());
    mockCanManage.mockResolvedValue(false);
    await render();
    const note = container.querySelector(
      '[data-testid="admins-no-permission"]',
    );
    expect(note?.textContent).toContain('GroupMember.Read.All');
    expect(note?.querySelector('a')?.getAttribute('href')).toContain(GROUP);
  });

  test('read-only when the write permission is missing', async () => {
    mockGetTenantMe.mockResolvedValue(tenant(GROUP));
    mockList.mockResolvedValue([
      { id: 'u1', displayName: 'Ada', userPrincipalName: 'ada@example.test' },
    ]);
    mockCanManage.mockResolvedValue(false);
    await render();
    const row = container.querySelector(
      'table[aria-label="Zaplie admins"] tbody tr',
    );
    expect(row?.textContent).toBe('Adaada@example.test');
    expect(row?.querySelector('button')).toBe(null);
    expect(
      container.querySelector('[data-testid="admins-read-only"]'),
    ).not.toBe(null);
    expect(container.querySelector('button[aria-label="Remove Ada"]')).toBe(
      null,
    );
  });

  test('adds and removes members when Graph allows it', async () => {
    mockGetTenantMe.mockResolvedValue(tenant(GROUP));
    mockList.mockResolvedValue([
      { id: 'u1', displayName: 'Ada', userPrincipalName: 'ada@example.test' },
    ]);
    mockCanManage.mockResolvedValue(true);
    mockAdd.mockResolvedValue(undefined);
    mockRemove.mockResolvedValue(undefined);
    await render();

    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="New admin\'s sign-in name"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, 'bea@example.test');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find(button => button.textContent === 'Add admin')!
        .click();
    });
    await settle();
    expect(mockAdd).toHaveBeenCalledWith(GROUP, 'bea@example.test');

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Remove Ada"]')!
        .click();
    });
    await settle();
    expect(mockRemove).toHaveBeenCalledWith(GROUP, 'u1');
  });

  test('renders nothing for a non-admin', async () => {
    mockIsZaplieAdmin.mockReturnValue(false);
    await render();
    expect(container.innerHTML).toBe('');
    expect(mockGetTenantMe).not.toHaveBeenCalled();
  });
});
