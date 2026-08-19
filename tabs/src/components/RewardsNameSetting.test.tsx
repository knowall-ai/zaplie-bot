import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import RewardsNameSetting from './RewardsNameSetting';
import { RewardNameContext } from './RewardNameContext';

const mockUseMsal = jest.fn();
const mockAcquireIdToken = jest.fn();
const mockUpdateRewardName = jest.fn();
const mockToastSuccess = jest.fn();
const mockToastError = jest.fn();

jest.mock('@azure/msal-react', () => ({
  useMsal: () => mockUseMsal(),
}));

jest.mock('../services/adminRole', () => ({
  acquireIdToken: () => mockAcquireIdToken(),
  isZaplieAdmin: () => true,
}));

jest.mock('../apiService', () => ({
  updateRewardName: (idToken: string, rewardName: string) =>
    mockUpdateRewardName(idToken, rewardName),
}));

jest.mock('react-toastify', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

let container: HTMLDivElement;
let root: Root;

const mountSetting = (value: React.ContextType<typeof RewardNameContext>) => {
  root.render(
    <RewardNameContext.Provider value={value}>
      <RewardsNameSetting />
    </RewardNameContext.Provider>,
  );
};

const renderSetting = async (
  value: React.ContextType<typeof RewardNameContext>,
) => {
  await act(async () => {
    mountSetting(value);
  });
};

const settle = async () => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const eventually = async (assertion: () => void) => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await settle();
    }
  }
  throw lastError;
};

const getButton = (label: string) => {
  const button = Array.from(container.querySelectorAll('button')).find(
    candidate => candidate.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Button "${label}" was not rendered.`);
  return button;
};

const setInputValue = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  if (!setter) throw new Error('The input value setter is unavailable.');
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('RewardsNameSetting', () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    jest.clearAllMocks();
    mockAcquireIdToken.mockResolvedValue('id-token');
    mockUseMsal.mockReturnValue({
      instance: {},
      accounts: [{ localAccountId: 'aad-1' }],
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  test('shows the configuration failure and exposes retry', async () => {
    const retry = jest.fn();

    await renderSetting({
      rewardName: null,
      setRewardName: jest.fn(),
      isLoading: false,
      error: new Error('Configuration unavailable'),
      retry,
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "We couldn't load the current reward name.",
    );
    await act(async () => {
      getButton('Try again').click();
    });
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test('normalizes and saves an admin edit into shared context', async () => {
    const setRewardName = jest.fn();
    mockUpdateRewardName.mockResolvedValue({ rewardName: 'Points' });

    await renderSetting({
      rewardName: 'Sats',
      setRewardName,
      isLoading: false,
      error: null,
      retry: jest.fn(),
    });

    await act(async () => {
      getButton('Edit').click();
    });
    const input = container.querySelector('input');
    if (!input) throw new Error('Reward name input was not rendered.');
    await act(async () => {
      setInputValue(input, '  Points  ');
    });
    await act(async () => {
      getButton('Save').click();
    });

    await eventually(() => {
      expect(mockUpdateRewardName).toHaveBeenCalledWith('id-token', 'Points');
    });
    expect(setRewardName).toHaveBeenCalledWith('Points');
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'Reward name saved.',
    );
  });

  test('keeps a failed save visible and editable', async () => {
    mockUpdateRewardName.mockRejectedValue(new Error('backend unavailable'));

    await renderSetting({
      rewardName: 'Sats',
      setRewardName: jest.fn(),
      isLoading: false,
      error: null,
      retry: jest.fn(),
    });

    await act(async () => {
      getButton('Edit').click();
    });
    await act(async () => {
      getButton('Save').click();
    });
    await eventually(() => {
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "We couldn't save the reward name. Try again.",
      );
    });
    expect(
      (container.querySelector('input') as HTMLInputElement).disabled,
    ).toBe(false);
    expect(mockToastError).toHaveBeenCalledWith('Error updating reward name.');
  });
});
