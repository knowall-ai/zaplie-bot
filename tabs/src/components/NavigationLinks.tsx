import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { isActivePath } from '../utils/navigation';

/**
 * Navigation link configuration
 */
interface NavLink {
  path: string;
  label: string;
}

/**
 * Props for the NavigationLinks component
 */
interface NavigationLinksProps {
  /**
   * CSS class name for each link
   */
  linkClassName?: string;
  /**
   * CSS class name for active links
   */
  activeLinkClassName?: string;
}

/**
 * Navigation links configuration - single source of truth for all navigation items
 */
const NAV_LINKS: NavLink[] = [
  { path: '/feed', label: 'Feed' },
  { path: '/users', label: 'Users' },
  { path: '/rewards', label: 'Rewards' },
  { path: '/wallet', label: 'Wallet' },
  { path: '/settings', label: 'Settings' },
];

/**
 * Shared navigation links component used by both Header and Footer.
 * Provides consistent navigation across the application with proper accessibility support.
 *
 * @param props - Component props
 * @returns Navigation links fragment
 */
const NavigationLinks: React.FC<NavigationLinksProps> = ({
  linkClassName = '',
  activeLinkClassName = '',
}) => {
  const location = useLocation();
  const isActive = (path: string) => isActivePath(location.pathname, path);

  return (
    <>
      {NAV_LINKS.map(({ path, label }) => (
        <Link
          key={path}
          to={path}
          className={`${linkClassName} ${isActive(path) ? activeLinkClassName : ''}`.trim()}
          aria-current={isActive(path) ? 'page' : undefined}
        >
          {label}
        </Link>
      ))}
    </>
  );
};

export default NavigationLinks;
