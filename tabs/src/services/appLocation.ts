// Where this build of the app lives, and where its API is.
//
// The same bundle serves two homes: the Teams tabs at the root of the portal
// App Service (same-origin Express backend under /api), and the signed-in
// portal on the marketing site at https://getzapl.ie/portal/ (a static copy,
// whose API is the App Service). Both are build-time settings, so nothing
// here is read from the page or the URL at runtime:
//
// - PUBLIC_URL is Create React App's base path. CRA inlines it as
//   process.env.PUBLIC_URL ('' at the root, '/portal' under /portal/), and
//   also rewrites the asset paths in index.html with it.
// - REACT_APP_API_BASE_URL is the origin of the Express backend when it is
//   not the page's own origin. Unset, API calls stay same-origin as before.
//
// Both are public values (a path and a hostname), never a secret.

const trimTrailingSlashes = (value: string): string =>
  value.replace(/\/+$/, '');

/**
 * The app's base path, without a trailing slash: '' at the root, '/portal'
 * under /portal/. CRA accepts PUBLIC_URL as a path or a full URL; only the
 * path matters here, as every link is built on the page's own origin.
 */
export const getBasePath = (): string => {
  const raw = (process.env.PUBLIC_URL ?? '').trim();
  if (!raw || raw === '.' || raw === '/') {
    return '';
  }

  let path = raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      path = new URL(raw).pathname;
    } catch {
      return '';
    }
  }

  path = trimTrailingSlashes(path);
  if (!path) {
    return '';
  }
  return path.startsWith('/') ? path : `/${path}`;
};

/**
 * The app's own origin plus its base path, with no trailing slash:
 * https://host at the root, https://host/portal under /portal/. This is the
 * MSAL redirect URI, so it must match the app registration exactly.
 */
export const getAppOrigin = (origin = window.location.origin): string =>
  `${origin}${getBasePath()}`;

/** An absolute URL for a route of this app, such as appUrl('/auth-end'). */
export const appUrl = (
  routePath: string,
  origin = window.location.origin,
): string => {
  const path = routePath.startsWith('/') ? routePath : `/${routePath}`;
  return `${getAppOrigin(origin)}${path}`;
};

/**
 * The backend's base URL without a trailing slash: '' (same origin) unless
 * REACT_APP_API_BASE_URL names another origin.
 */
export const getApiBaseUrl = (): string =>
  trimTrailingSlashes((process.env.REACT_APP_API_BASE_URL ?? '').trim());

/** The URL for a backend path, such as apiUrl('/api/reward-name'). */
export const apiUrl = (apiPath: string): string => {
  const path = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  return `${getApiBaseUrl()}${path}`;
};
