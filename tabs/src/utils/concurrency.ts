// The wallet lookup is one request per user. Browsers cap concurrent requests
// per host, so an unbounded fan-out leaves the surplus queued in the browser
// while the gateway client's 30s timeout runs down against the queued request
// rather than the server — late users then render with blank wallet columns.
export const WALLET_FETCH_CONCURRENCY = 5;

/**
 * Runs `worker` over `items` with at most `limit` calls in flight at a time,
 * preserving input order in the returned array. Rejects on the first failure,
 * exactly like `Promise.all`.
 */
export const mapWithConcurrency = async <TIn, TOut>(
  items: TIn[],
  limit: number,
  worker: (item: TIn) => Promise<TOut>,
): Promise<TOut[]> => {
  const results = new Array<TOut>(items.length);
  let next = 0;

  const runner = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runner()),
  );

  return results;
};
