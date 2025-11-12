import React from 'react';
import { Link } from 'react-router-dom';
import styles from './FooterComponent.module.css';
import SignInSignOutButton from './SignInSignOutButton';

type FooterComponentProps = {
  hidden: boolean;
};

const FooterComponent: React.FC<FooterComponentProps> = ({ hidden }) => {

  if (hidden) {
    return null;
}
  return (
    <footer className={styles.footer}>
      <Link to="/feed">Feed</Link>&nbsp;|&nbsp;
      <Link to="/users">Users</Link>&nbsp;|&nbsp;
      <Link to="/rewards">Rewards</Link>&nbsp;|&nbsp;
      <Link to="/wallet">Wallet</Link>&nbsp;|&nbsp;
      <Link to="/settings">Settings</Link>&nbsp;|&nbsp;
      <SignInSignOutButton />
      <div style={{ marginTop: '10px', fontSize: '12px', color: '#666' }}>
        Built by KnowAll AI | Contact: <a href="mailto:hello@knowall.ai" style={{ color: '#666' }}>hello@knowall.ai</a> | <a href="https://www.knowall.ai" target="_blank" rel="noopener noreferrer" style={{ color: '#666' }}>www.knowall.ai</a>
      </div>
    </footer>

  );
};

export default FooterComponent;
