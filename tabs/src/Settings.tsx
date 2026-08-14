import AdminConfigSetting from './components/AdminConfigSetting';
import ConnectionsSetting from './components/ConnectionsSetting';
import styles from './components/setting.module.css';
import { KNOWALL_CONSTANTS } from './constants/branding';

const Settings: React.FC = () => {
  return (
    <div className={styles.mainContainer}>
      <header className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Settings</h1>
        <p className={styles.pageSubtitle}>
          Team-wide reward configuration and the accounts linked to your
          profile.
        </p>
        <span className={styles.providedBy}>
          Built by {KNOWALL_CONSTANTS.name}
        </span>
      </header>
      <AdminConfigSetting />
      <ConnectionsSetting />
    </div>
  );
};

export default Settings;
