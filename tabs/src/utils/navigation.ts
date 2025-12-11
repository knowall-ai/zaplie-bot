/**
 * Shared navigation utilities for route matching.
 * These utilities are used by HeaderComponent and FooterComponent
 * to determine active navigation states.
 */

/**
 * Checks if a given path is currently active based on the current location.
 *
 * This function uses precise matching to avoid false positives:
 * - Exact matches always return true (e.g., '/settings' matches '/settings')
 * - Nested routes are matched when the current path starts with targetPath + '/'
 *   (e.g., '/settings/profile' matches '/settings', but '/settings-advanced' does NOT)
 * - The root path '/' only matches exactly to prevent it from matching all paths
 * - Trailing slashes are normalized to handle edge cases like '/settings/' matching '/settings'
 *
 * @param currentPath - The current location pathname (e.g., location.pathname)
 * @param targetPath - The navigation target path to check against (e.g., '/settings')
 * @returns true if the targetPath should be considered active for the currentPath
 *
 * @example
 * isActivePath('/settings', '/settings') // true - exact match
 * isActivePath('/settings/', '/settings') // true - trailing slash normalized
 * isActivePath('/settings/profile', '/settings') // true - nested route
 * isActivePath('/settings-advanced', '/settings') // false - different route
 * isActivePath('/feed', '/') // false - root only matches exactly
 */
export const isActivePath = (currentPath: string, targetPath: string): boolean => {
  // Validate inputs to prevent runtime errors
  if (!currentPath || !targetPath) {
    return false;
  }

  // Normalize paths by removing trailing slashes (but keep root '/' intact)
  const normalizedCurrent = currentPath.replace(/\/+$/, '') || '/';
  const normalizedTarget = targetPath.replace(/\/+$/, '') || '/';

  // Exact match
  if (normalizedCurrent === normalizedTarget) {
    return true;
  }

  // For nested routes: must start with path followed by a slash
  // This prevents /settings from matching /settings-advanced
  // But allows /settings to match /settings/profile
  if (normalizedTarget !== '/') {
    return normalizedCurrent.startsWith(normalizedTarget + '/');
  }

  // Special case for root path - only exact match
  return false;
};
