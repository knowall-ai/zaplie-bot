import React, { useEffect, useState } from 'react';
import { useMsal, useAccount } from '@azure/msal-react';
import { Link } from 'react-router-dom';
import styles from './HeaderComponent.module.css';
import { KNOWALL_CONSTANTS } from '../constants/branding';

const HeaderComponent: React.FC = () => {
  const { accounts } = useMsal();
  const account = useAccount(accounts[0] || {});
  const [userName, setUserName] = useState<string>('');
  const [userEmail, setUserEmail] = useState<string>('');

  useEffect(() => {
    if (account) {
      setUserName(account.name || '');
      setUserEmail(account.username || '');
    }
  }, [account]);

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
          <div className={styles.userInfo}>
            <div className={styles.avatar}>
              {getInitials(userName)}
            </div>
            <div className={styles.userDetails}>
              <div className={styles.userName}>{userName}</div>
              <div className={styles.userEmail}>{userEmail}</div>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
};

export default HeaderComponent;
