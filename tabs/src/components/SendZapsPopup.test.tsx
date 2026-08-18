import { pickExactWallet, prepareZapRequest } from '../utils/paymentState';

const wallet = (id: string, name: string): Wallet => ({
  id,
  name,
  user: 'user-1',
  balance_msat: 20_000,
  deleted: false,
});

describe('SendZapsPopup payment identity', () => {
  test('accepts one exact wallet name and rejects ambiguous matches', () => {
    expect(
      pickExactWallet(
        [
          wallet('private-archive', 'Private archive'),
          wallet('p1', ' private '),
        ],
        'private',
      )?.id,
    ).toBe('p1');
    expect(
      pickExactWallet(
        [wallet('p1', 'Private'), wallet('p2', 'private')],
        'private',
      ),
    ).toBeNull();
  });

  test('reuses one idempotency key for retries of the same zap', () => {
    const createKey = jest
      .fn<string, []>()
      .mockReturnValueOnce('request-1')
      .mockReturnValueOnce('request-2');
    const first = prepareZapRequest(null, 'recipient:20:memo', createKey);
    const retry = prepareZapRequest(first, 'recipient:20:memo', createKey);
    const changed = prepareZapRequest(first, 'recipient:40:memo', createKey);

    expect(retry).toBe(first);
    expect(changed.key).toBe('request-2');
    expect(createKey).toHaveBeenCalledTimes(2);
  });
});
