const PLACEHOLDER = 'your-secret-token';
const LOCAL_BACKEND_URL = 'http://localhost:5000/api';

export const tabBackendAuthHeader = (): string => {
  const token = process.env.TAB_BACKEND_TOKEN;
  if (!token || token === PLACEHOLDER) {
    throw new Error(
      'TAB_BACKEND_TOKEN is not set to a real value. Generate one with `openssl rand -hex 32`.',
    );
  }
  return token;
};

export const tabBackendApiUrl = (): string => {
  const url = process.env.WEBSITE_API_URL;
  if (url) {
    return url.replace(/\/$/, '');
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('WEBSITE_API_URL is required in production.');
  }
  return LOCAL_BACKEND_URL;
};
