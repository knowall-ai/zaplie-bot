import React from 'react';
import { Link } from 'react-router-dom';
import styles from './FooterComponent.module.css';
import SignInSignOutButton from './SignInSignOutButton';
import { KNOWALL_CONSTANTS } from '../constants/branding';
import { useTeamsContext } from '../utils/useTeamsContext';

type FooterComponentProps = {
  hidden: boolean;
};

const FooterComponent: React.FC<FooterComponentProps> = ({ hidden }) => {
  const isInTeams = useTeamsContext();

  // Hide navigation if explicitly hidden via prop or if running in Teams
  if (hidden || isInTeams) {
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
         <a
          href={KNOWALL_CONSTANTS.website}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.knowallLink}
          aria-label="Visit KnowAll AI website"
        >
          <span className={styles.knowallBadge}>{KNOWALL_CONSTANTS.name}</span>
        </a>
      </div>
    </footer>

  );
};

export default FooterComponent;
