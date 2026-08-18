import React, { act, useContext } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { RewardNameContext, RewardNameProvider } from './RewardNameContext';

const mockGetRewardName = jest.fn();

jest.mock('../apiService', () => ({
  getRewardName: () => mockGetRewardName(),
}));

const Consumer = () => {
  const { rewardName, isLoading, error, retry } = useContext(RewardNameContext);

  return (
    <div>
      <span data-testid="child">Portal content</span>
      <span data-testid="reward-name">{rewardName ?? ''}</span>
      <span data-testid="loading">{isLoading ? 'loading' : 'ready'}</span>
      {error ? <span role="alert">{error.message}</span> : null}
      <button type="button" onClick={retry}>
        Retry
      </button>
    </div>
  );
};

let container: HTMLDivElement;
let root: Root;

const mountProvider = () => {
  root.render(
    <RewardNameProvider>
      <Consumer />
    </RewardNameProvider>,
  );
};

const renderProvider = async () => {
  await act(async () => {
    mountProvider();
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

describe('RewardNameProvider', () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    jest.clearAllMocks();
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

  test('keeps portal content mounted while the reward name loads', async () => {
    mockGetRewardName.mockReturnValue(new Promise(() => undefined));

    await renderProvider();

    expect(container.querySelector('[data-testid="child"]')?.textContent).toBe(
      'Portal content',
    );
    expect(
      container.querySelector('[data-testid="loading"]')?.textContent,
    ).toBe('loading');
    expect(
      container.querySelector('[data-testid="reward-name"]')?.textContent,
    ).toBe('');
  });

  test('exposes a failed request and retries it without inventing a value', async () => {
    mockGetRewardName
      .mockRejectedValueOnce(new Error('Configuration unavailable'))
      .mockResolvedValueOnce({ rewardName: 'Sats' });

    await renderProvider();
    await eventually(() => {
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        'Configuration unavailable',
      );
    });
    expect(
      container.querySelector('[data-testid="reward-name"]')?.textContent,
    ).toBe('');

    await act(async () => {
      const retryButton = container.querySelector('button');
      if (!retryButton) throw new Error('Retry button was not rendered.');
      retryButton.click();
    });

    await eventually(() => {
      expect(
        container.querySelector('[data-testid="reward-name"]')?.textContent,
      ).toBe('Sats');
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(mockGetRewardName).toHaveBeenCalledTimes(2);
  });
});
