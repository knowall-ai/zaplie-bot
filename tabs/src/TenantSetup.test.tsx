import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import TenantSetup from './TenantSetup';

const mockIsSetupAdmin = jest.fn();
const mockGetTenantMe = jest.fn();
const mockSave = jest.fn();
const mockOrgName = jest.fn();

jest.mock('@azure/msal-react', () => ({ useMsal: () => ({ accounts: [{}] }) }));
jest.mock('./services/adminRole', () => ({
  isSetupAdmin: () => mockIsSetupAdmin(),
}));
jest.mock('./services/tenant', () => ({
  getTenantMe: () => mockGetTenantMe(),
  saveTenantSetup: (patch: unknown) => mockSave(patch),
  getOrganizationName: () => mockOrgName(),
  enterpriseAppUsersLink: (clientId: string) =>
    `https://entra.example/app/${clientId}`,
}));

const GROUP = 'abcdef01-2345-4678-9abc-def012345678';
let container: HTMLDivElement;
let root: Root;
const settle = async () => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};
const mount = () => {
  root.render(
    <MemoryRouter>
      <TenantSetup />
    </MemoryRouter>,
  );
};
const render = async () => {
  await act(async () => {
    mount();
  });
  await settle();
};
const type = async (
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) => {
  const proto =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockOrgName.mockResolvedValue(null);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('TenantSetup', () => {
  test('is refused to people who are not administrators', async () => {
    mockIsSetupAdmin.mockReturnValue(false);
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Admins only',
    );
    expect(mockGetTenantMe).not.toHaveBeenCalled();
  });

  test('saves the admins group, guests and provisioner defaults for the organisation', async () => {
    mockIsSetupAdmin.mockReturnValue(true);
    mockGetTenantMe.mockResolvedValue({
      tid: 'tenant-1',
      clientId: 'client-1',
      settings: {
        adminsGroupId: null,
        guestAllowlist: [],
        provisioner: { defaultBudgetSats: 25000, defaultPeriod: 'weekly' },
      },
    });
    mockSave.mockResolvedValue({ settings: {} });
    await render();

    expect(
      container.querySelector('a[href="https://entra.example/app/client-1"]'),
    ).not.toBe(null);
    await type(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="Zaplie Admins group object id"]',
      )!,
      GROUP,
    );
    await type(
      container.querySelector<HTMLTextAreaElement>('#setup-guests')!,
      '@partner.example\nann@partner.example',
    );
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find(button => button.textContent === 'Save')!
        .click();
    });
    await settle();

    expect(mockSave).toHaveBeenCalledWith({
      adminsGroupId: GROUP,
      guestAllowlist: ['@partner.example', 'ann@partner.example'],
      provisioner: { defaultBudgetSats: 25000, defaultPeriod: 'weekly' },
    });
    expect(container.textContent).toContain('Saved.');
  });

  const tenantMe = {
    tid: 'tenant-1',
    clientId: 'client-1',
    settings: {
      adminsGroupId: null,
      guestAllowlist: [],
      provisioner: { defaultBudgetSats: 25000, defaultPeriod: 'weekly' },
    },
  };

  test('shows the organisation name from Graph, with the tenant id', async () => {
    mockIsSetupAdmin.mockReturnValue(true);
    mockGetTenantMe.mockResolvedValue(tenantMe);
    mockOrgName.mockResolvedValue('KnowAll AI');
    await render();

    const heading = container.querySelector('[data-testid="setup-tenant"]');
    expect(heading?.textContent).toContain('KnowAll AI');
    expect(heading?.textContent).toContain('tenant-1');
  });

  test('the group id is a single-line field that refuses a non-GUID', async () => {
    mockIsSetupAdmin.mockReturnValue(true);
    mockGetTenantMe.mockResolvedValue(tenantMe);
    await render();

    const input = container.querySelector<HTMLInputElement>('#setup-group')!;
    expect(input.tagName).toBe('INPUT');
    await type(input, 'not-a-guid');

    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "That isn't an object id",
    );
    const save = Array.from(container.querySelectorAll('button')).find(
      button => button.textContent === 'Save',
    )!;
    expect(save.disabled).toBe(true);
  });
});
