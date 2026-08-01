const PLACEHOLDER = 'your-secret-token';

export const tabBackendAuthHeader = (): string => {
  const token = process.env.TAB_BACKEND_TOKEN;
  if (!token || token === PLACEHOLDER) {
    throw new Error(
      'TAB_BACKEND_TOKEN is not set to a real value. Generate one with `openssl rand -hex 32`.',
    );
  }
  return token;
};
