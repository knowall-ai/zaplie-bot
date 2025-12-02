import React, { useEffect, useState, useRef } from 'react';
import { useMsal, useAccount } from '@azure/msal-react';
import { Link } from 'react-router-dom';
import * as microsoftTeams from '@microsoft/teams-js';
import styles from './HeaderComponent.module.css';

const HeaderComponent: React.FC = () => {
  const { instance, accounts } = useMsal();
  const account = useAccount(accounts[0] || {});
  const [userName, setUserName] = useState<string>('');
  const [userEmail, setUserEmail] = useState<string>('');
  const [isDropdownOpen, setIsDropdownOpen] = useState<boolean>(false);
  const [isInTeams, setIsInTeams] = useState<boolean>(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (account) {
      setUserName(account.name || '');
      setUserEmail(account.username || '');
    }
  }, [account]);

  // Initialize Teams SDK and detect if running in Teams
  useEffect(() => {
    microsoftTeams.app
      .initialize()
      .then(() => {
        microsoftTeams.app
          .getContext()
          .then(() => {
            setIsInTeams(true);
          })
          .catch(() => {});
      })
      .catch(() => {});
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const handleLogout = async () => {
    try {
      await instance.logoutPopup({
        postLogoutRedirectUri: window.location.origin + '/login',
        account: accounts[0] || null,
      });
    } catch (error) {
      console.error('Error during logout:', error);
    }
  };

  const toggleDropdown = () => {
    setIsDropdownOpen(!isDropdownOpen);
  };

  if (!account) {
    return null;
  }

  // Get initials for avatar
  const getInitials = (name: string) => {
    if (!name) return '?';
    const nameParts = name.trim().split(' ');
    if (nameParts.length >= 2) {
      return `${nameParts[0][0]}${nameParts[nameParts.length - 1][0]}`.toUpperCase();
    }
    return name.substring(0, 2).toUpperCase();
  };

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
            <div className={styles.userInfo} onClick={toggleDropdown}>
              <div className={styles.avatar}>
                {getInitials(userName)}
              </div>
              <div className={styles.userDetails}>
                <div className={styles.userName}>{userName}</div>
                <div className={styles.userEmail}>{userEmail}</div>
              </div>
              <div className={styles.dropdownArrow}>
                {isDropdownOpen ? '▲' : '▼'}
              </div>
            </div>
            {isDropdownOpen && (
              <div className={styles.dropdownMenu}>
                <button className={styles.dropdownItem} onClick={handleLogout}>
                  Sign Out
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
