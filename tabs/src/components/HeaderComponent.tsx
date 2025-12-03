import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useAccount, useIsAuthenticated, useMsal } from '@azure/msal-react';
import { InteractionStatus } from '@azure/msal-browser';
import { Link } from 'react-router-dom';
import styles from './HeaderComponent.module.css';
import { useTeamsAuth } from '../hooks/useTeamsAuth';

const HeaderComponent: React.FC = () => {
  const { accounts, inProgress } = useMsal();
  const account = useAccount(accounts[0] || {});
  const isAuthenticated = useIsAuthenticated();
  const [userName, setUserName] = useState<string>('');
  const [userEmail, setUserEmail] = useState<string>('');
  const [isDropdownOpen, setIsDropdownOpen] = useState<boolean>(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const dropdownButtonRef = useRef<HTMLDivElement>(null);

  // Use shared Teams auth hook
  const { handleLogout, isLoggingOut, isTeamsInitializing } = useTeamsAuth();

  useEffect(() => {
    if (account) {
      setUserName(account.name || '');
      setUserEmail(account.username || '');
    }
  }, [account]);

  // Close dropdown when clicking outside
  useEffect(() => {
    let mounted = true;

    const handleClickOutside = (event: MouseEvent) => {
      if (mounted && dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      mounted = false;
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const toggleDropdown = useCallback(() => {
    setIsDropdownOpen(prev => !prev);
  }, []);

  const closeDropdown = useCallback(() => {
    setIsDropdownOpen(false);
    // Return focus to the dropdown button
    dropdownButtonRef.current?.focus();
  }, []);

  // Keyboard navigation handler
  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    switch (event.key) {
      case 'Enter':
      case ' ':
        event.preventDefault();
        toggleDropdown();
        break;
      case 'Escape':
        event.preventDefault();
        closeDropdown();
        break;
      case 'ArrowDown':
        if (!isDropdownOpen) {
          event.preventDefault();
          setIsDropdownOpen(true);
        }
        break;
    }
  }, [isDropdownOpen, toggleDropdown, closeDropdown]);

  // Keyboard handler for dropdown items
  const handleDropdownItemKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeDropdown();
    }
  }, [closeDropdown]);

  const onLogoutClick = useCallback(async () => {
    closeDropdown();
    await handleLogout();
  }, [handleLogout, closeDropdown]);

  // Get initials for avatar
  const getInitials = (name: string) => {
    if (!name) return '?';
    const nameParts = name.trim().split(' ');
    if (nameParts.length >= 2) {
      return `${nameParts[0][0]}${nameParts[nameParts.length - 1][0]}`.toUpperCase();
    }
    return name.substring(0, 2).toUpperCase();
  };

  // Show loading skeleton during authentication initialization
  const isLoading = inProgress !== InteractionStatus.None || isTeamsInitializing;

  if (isLoading) {
    return (
      <header className={styles.header}>
        <div className={styles.headerContent}>
          <div className={styles.leftSection}>
            <Link to="/feed" className={styles.logoLink}>
              <span className={styles.appName}>Zaplie</span>
            </Link>
          </div>
          <div className={styles.rightSection}>
            <div className={styles.userInfoSkeleton}>
              <div className={styles.avatarSkeleton} />
              <div className={styles.detailsSkeleton}>
                <div className={styles.nameSkeleton} />
                <div className={styles.emailSkeleton} />
              </div>
            </div>
          </div>
        </div>
      </header>
    );
  }

  // Don't render user info if not authenticated
  if (!isAuthenticated || !account) {
    return (
      <header className={styles.header}>
        <div className={styles.headerContent}>
          <div className={styles.leftSection}>
            <Link to="/feed" className={styles.logoLink}>
              <span className={styles.appName}>Zaplie</span>
            </Link>
          </div>
        </div>
      </header>
    );
  }

  return (
    <header className={styles.header}>
      <div className={styles.headerContent}>
        <div className={styles.leftSection}>
          <Link to="/feed" className={styles.logoLink}>
            <span className={styles.appName}>Zaplie</span>
          </Link>
        </div>

        <div className={styles.rightSection}>
          <div className={styles.userInfoWrapper} ref={dropdownRef}>
            <div
              ref={dropdownButtonRef}
              className={styles.userInfo}
              onClick={toggleDropdown}
              onKeyDown={handleKeyDown}
              role="button"
              tabIndex={0}
              aria-expanded={isDropdownOpen}
              aria-haspopup="menu"
              aria-label={`User menu for ${userName}`}
            >
              <div className={styles.avatar} aria-hidden="true">
                {getInitials(userName)}
              </div>
              <div className={styles.userDetails}>
                <div className={styles.userName}>{userName}</div>
                <div className={styles.userEmail}>{userEmail}</div>
              </div>
              <div className={styles.dropdownArrow} aria-hidden="true">
                {isDropdownOpen ? '▲' : '▼'}
              </div>
            </div>
            {isDropdownOpen && (
              <div
                className={styles.dropdownMenu}
                role="menu"
                aria-label="User actions"
              >
                <button
                  className={styles.dropdownItem}
                  onClick={onLogoutClick}
                  onKeyDown={handleDropdownItemKeyDown}
                  role="menuitem"
                  disabled={isLoggingOut}
                >
                  {isLoggingOut ? 'Signing out...' : 'Sign Out'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};

export default HeaderComponent;
