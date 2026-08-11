jest.mock('axios', () => ({
  __esModule: true,
  default: {
    isAxiosError: (error: { isAxiosError?: boolean }) => error?.isAxiosError === true,
  },
}));

import { sanitizeApiError } from './apiService';

test('sanitizes Axios failures without retaining bearer headers or request data', () => {
  const error = {
    isAxiosError: true,
    message: 'Request failed with status code 401',
    code: 'ERR_BAD_REQUEST',
    response: { status: 401 },
    config: {
      headers: { Authorization: 'Bearer must-not-be-logged' },
      data: JSON.stringify({ botPersona: 'private administrator configuration' }),
    },
  };

  const summary = sanitizeApiError(error);

  expect(summary).toEqual({
    message: 'Request failed with status code 401',
    status: 401,
    code: 'ERR_BAD_REQUEST',
  });
  expect(JSON.stringify(summary)).not.toContain('must-not-be-logged');
  expect(JSON.stringify(summary)).not.toContain('private administrator configuration');
});
