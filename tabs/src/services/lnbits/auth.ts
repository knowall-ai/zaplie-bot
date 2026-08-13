import { logger } from '../../utils/logger';
import { nodeUrl } from './config';

// Store token in sessionStorage (cleared when tab closes - more secure than localStorage)
// Token expiration: tokens expire after 24 hours
const TOKEN_EXPIRY_HOURS = 24;
const TOKEN_KEY = 'accessToken';
const TOKEN_TIMESTAMP_KEY = 'accessTokenTimestamp';

// Get token from storage if valid, otherwise return null
const getStoredToken = (): string | null => {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const timestamp = sessionStorage.getItem(TOKEN_TIMESTAMP_KEY);

  if (!token || !timestamp) {
    return null;
  }

  // Check if token has expired
  const tokenAge = Date.now() - parseInt(timestamp, 10);
  const tokenAgeHours = tokenAge / (1000 * 60 * 60);

  if (tokenAgeHours > TOKEN_EXPIRY_HOURS) {
    // Token expired, clear storage
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_TIMESTAMP_KEY);
    return null;
  }

  return token;
};

let accessToken = getStoredToken();
let accessTokenPromise: Promise<string> | null = null; // To cache the pending token request

export async function getAccessToken(
  username: string,
  password: string,
): Promise<string> {
  logger.debug('=== getAccessToken DEBUG ===');

  if (accessToken) {
    return accessToken;
  } else {
    logger.debug('No cached access token found');
  }

  // If there's already a token request in progress, return the existing promise
  if (accessTokenPromise) {
    logger.debug('Returning ongoing access token request');
    return accessTokenPromise;
  }

  // No access token and no request in progress, create a new one
  logger.debug('No cached access token found, requesting a new one');

  // Store the promise of the request
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

      // Store the access token in memory and sessionStorage with timestamp
      accessToken = data.access_token;
      if (accessToken) {
        sessionStorage.setItem(TOKEN_KEY, accessToken);
        sessionStorage.setItem(TOKEN_TIMESTAMP_KEY, Date.now().toString());
        logger.info(
          'Access token fetched and stored (expires in ' +
            TOKEN_EXPIRY_HOURS +
            ' hours)',
        );
      } else {
        throw new Error(
          'Access token is null, cannot store in sessionStorage.',
        );
      }

      // Return the access token
      return accessToken;
    } catch (error) {
      logger.error('Error in getAccessToken:', error);
      // Throw an error to ensure the promise doesn't resolve with undefined
      throw new Error('Failed to retrieve access token');
    } finally {
      // Reset the promise to allow future requests
      accessTokenPromise = null;
    }
  })();

  // Return the token promise
  return accessTokenPromise;
}
