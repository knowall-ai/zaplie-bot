import RewardsNameSetting from './components/RewardsNameSetting';
import BotPersonaSetting from './components/BotPersonaSetting';
import ConnectionsSetting from './components/ConnectionsSetting';
import DirectoryAdminSetting from './components/DirectoryAdminSetting';
import AdminsSetting from './components/AdminsSetting';
import { Link } from 'react-router-dom';
import { useMsal } from '@azure/msal-react';
import styles from './components/Settings.module.css';
import { isSetupAdmin } from './services/adminRole';
import { KNOWALL_CONSTANTS } from './constants/branding';

const Settings: React.FC = () => {
  const { accounts } = useMsal();
  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Settings</h1>
        <p className={styles.pageCredit}>Built by {KNOWALL_CONSTANTS.name}</p>
      </header>
      {isSetupAdmin(accounts[0]) ? (
        <p>
          <Link to="/setup">Set up your organisation</Link>
        </p>
      ) : null}
      <RewardsNameSetting />
      <BotPersonaSetting />
      <ConnectionsSetting />
      <DirectoryAdminSetting />
      <AdminsSetting />
    </div>
  );
};

export default Settings;
