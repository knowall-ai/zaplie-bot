export const installFetchMock = (): jest.MockedFunction<typeof fetch> => {
  const mockFetch = jest.fn() as unknown as jest.MockedFunction<typeof fetch>;
  global.fetch = mockFetch;
  return mockFetch;
};

export const jsonResponse = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => 'application/json' },
    json: async () => body,
  }) as unknown as Response;

export const textResponse = (
  body: string,
  contentType = 'text/html',
): Response =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => contentType },
    text: async () => body,
  }) as unknown as Response;

export const errorResponse = (
  status: number,
  statusText = 'Server Error',
): Response =>
  ({
    ok: false,
    status,
    statusText,
    headers: { get: () => 'application/json' },
    json: async () => ({}),
  }) as unknown as Response;
