import { logger } from '../../utils/logger';
import { nodeUrl } from './config';

// sessionStorage rather than localStorage so the token dies with the tab.
const TOKEN_EXPIRY_HOURS = 24;
const TOKEN_KEY = 'accessToken';
const TOKEN_TIMESTAMP_KEY = 'accessTokenTimestamp';

const getStoredToken = (): string | null => {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const timestamp = sessionStorage.getItem(TOKEN_TIMESTAMP_KEY);

  if (!token || !timestamp) {
    return null;
  }

  const tokenAge = Date.now() - parseInt(timestamp, 10);
  const tokenAgeHours = tokenAge / (1000 * 60 * 60);

  if (tokenAgeHours > TOKEN_EXPIRY_HOURS) {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_TIMESTAMP_KEY);
    return null;
  }

  return token;
};

let accessToken = getStoredToken();
let accessTokenPromise: Promise<string> | null = null;

export async function getAccessToken(
  username: string,
  password: string,
): Promise<string> {
  if (accessToken) {
    return accessToken;
  }

  if (accessTokenPromise) {
    logger.debug('Returning ongoing access token request');
    return accessTokenPromise;
  }

  logger.debug('No cached access token found, requesting a new one');

  accessTokenPromise = (async (): Promise<string> => {
    try {
      const response = await fetch(`${nodeUrl}/api/v1/auth`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ username, password }),
      });

      if (!response.ok) {
        throw new Error(
          `Error creating access token (status: ${response.status}): ${response.statusText}`,
        );
      }

      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        throw new Error('Response is not in JSON format');
      }

      const data = await response.json();

      if (!data || !data.access_token) {
        throw new Error('Access token is missing in the response');
      }

      const token: string = data.access_token;
      accessToken = token;
      sessionStorage.setItem(TOKEN_KEY, token);
      sessionStorage.setItem(TOKEN_TIMESTAMP_KEY, Date.now().toString());
      logger.info(
        'Access token fetched and stored (expires in ' +
          TOKEN_EXPIRY_HOURS +
          ' hours)',
      );

      return token;
    } catch (error) {
      logger.error('Error in getAccessToken:', error);
      throw new Error('Failed to retrieve access token', { cause: error });
    } finally {
      // Reset the promise to allow future requests
      accessTokenPromise = null;
    }
  })();

  return accessTokenPromise;
}
