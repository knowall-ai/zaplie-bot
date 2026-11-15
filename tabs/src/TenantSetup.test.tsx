import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import TenantSetup from './TenantSetup';

const mockIsSetupAdmin = jest.fn();
const mockGetTenantMe = jest.fn();
const mockSave = jest.fn();

jest.mock('@azure/msal-react', () => ({ useMsal: () => ({ accounts: [{}] }) }));
jest.mock('./services/adminRole', () => ({
  isSetupAdmin: () => mockIsSetupAdmin(),
}));
jest.mock('./services/tenant', () => ({
  getTenantMe: () => mockGetTenantMe(),
  saveTenantSetup: (patch: unknown) => mockSave(patch),
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
});
