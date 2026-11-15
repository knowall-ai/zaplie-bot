import { ApiError, classifyError, newReferenceId } from './appErrors';

describe('classifyError', () => {
  test.each([
    [new ApiError('invalid token', 401), 'signed-out'],
    [new Error('Sign in is required'), 'signed-out'],
    [new ApiError('not a member of this organisation', 403), 'not-member'],
    [
      new ApiError('No Zaplie wallet is linked to this account', 403),
      'not-member',
    ],
    [new ApiError('Zaplie.Admin role required', 403), 'forbidden'],
    [
      new ApiError('The wallet service is unavailable', 502),
      'wallet-unreachable',
    ],
    [new Error('NWC get_balance timed out'), 'wallet-unreachable'],
    [new ApiError('not_found', 404), 'not-found'],
    [new Error('boom'), 'unknown'],
    ['string', 'unknown'],
  ])('%s is %s', (error, kind) => {
    expect(classifyError(error)).toBe(kind);
  });

  test('reference ids are short and unambiguous', () => {
    const ids = new Set(Array.from({ length: 50 }, newReferenceId));
    for (const id of Array.from(ids)) expect(id).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(ids.size).toBeGreaterThan(45);
  });
});
