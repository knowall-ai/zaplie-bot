import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import ZapContributionsChart from './ZapActivityChartComponent';

// react-activity-calendar ships ESM only, which the CRA jest transform does not
// load. The stub also exposes the computed days, which is what this test is
// about.
jest.mock('react-activity-calendar', () => ({
  ActivityCalendar: ({ data }: { data: { date: string; count: number }[] }) => (
    <div data-testid="calendar">{JSON.stringify(data)}</div>
  ),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const transaction = (time: number | string, amountSats: number): Transaction =>
  ({
    checking_id: `chk-${time}`,
    payment_hash: `hash-${time}`,
    pending: false,
    amount: -amountSats * 1000,
    fee: 0,
    memo: 'great work',
    time,
    extra: {},
    wallet_id: 'allowance-1',
  }) as Transaction;

describe('ZapContributionsChart', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = async (allZaps: Transaction[]) => {
    // This test uses React's raw createRoot API, which is not auto-wrapped.
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      root.render(
        <ZapContributionsChart
          timestamp={Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60}
          allZaps={allZaps}
          isLoading={false}
        />,
      );
    });
  };

  const totalCount = (): number =>
    (
      JSON.parse(
        container.querySelector('[data-testid="calendar"]')?.textContent ??
          '[]',
      ) as { count: number }[]
    ).reduce((sum, day) => sum + day.count, 0);

  test('renders when a transaction carries an unparseable timestamp', async () => {
    // Without the guard in toDateKey, toISOString throws a RangeError here and
    // the whole chart fails to render.
    await render([
      transaction('unknown', 500),
      transaction(Math.floor(Date.now() / 1000), 1000),
    ]);

    expect(container.querySelector('[data-testid="calendar"]')).not.toBeNull();
    // Only the valid zap is counted; the invalid one is dropped, not zeroed.
    expect(totalCount()).toBe(1000);
  });

  test('drops every invalid timestamp', async () => {
    await render([transaction('not-a-date', 500), transaction('', 900)]);

    expect(totalCount()).toBe(0);
  });
});
