import React from 'react';
import { Link } from 'react-router-dom';
import styles from './FooterComponent.module.css';
import SignInSignOutButton from './SignInSignOutButton';
import { KNOWALL_CONSTANTS } from '../constants/branding';

type FooterComponentProps = {
  hidden: boolean;
};

const FooterComponent: React.FC<FooterComponentProps> = ({ hidden }) => {

  if (hidden) {
    return null;
}
  return (
    <footer className={styles.footer}>
      <div className={styles.navigation}>
        <Link to="/feed">Feed</Link>
        <Link to="/users">Users</Link>
        <Link to="/rewards">Rewards</Link>
        <Link to="/wallet">Wallet</Link>
        <Link to="/settings">Settings</Link>
        <SignInSignOutButton />
      </div>
      <div className={styles.attribution}>
        <span className={styles.poweredBy}>Powered by</span>
        <a href={KNOWALL_CONSTANTS.website} target="_blank" rel="noopener noreferrer" className={styles.knowallLink}>
          <span className={styles.knowallBadge}>{KNOWALL_CONSTANTS.name}</span>
        </a>
        <span className={styles.separator}>•</span>
        <a href={`mailto:${KNOWALL_CONSTANTS.email}`} className={styles.contactLink}>{KNOWALL_CONSTANTS.email}</a>
      </div>
    </footer>

  );
};

export default FooterComponent;
