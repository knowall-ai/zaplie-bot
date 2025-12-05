import React from 'react';
import styles from './FooterComponent.module.css';
import { KNOWALL_CONSTANTS } from '../constants/branding';
import { useTeamsAuth } from '../hooks/useTeamsAuth';
import NavigationLinks from './NavigationLinks';

type FooterComponentProps = {
  hidden: boolean;
};

const FooterComponent: React.FC<FooterComponentProps> = ({ hidden }) => {
  const { isInTeams } = useTeamsAuth();

  if (hidden) {
    return null;
  }

  return (
    <footer className={styles.footer}>
      {/* Show navigation links ONLY in Teams context */}
      {isInTeams && (
        <nav className={styles.navigation} aria-label="Primary navigation">
          <NavigationLinks
            linkClassName=""
            activeLinkClassName={styles.active}
          />
        </nav>
      )}
      {/* Always show Powered by KnowAll AI */}
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
