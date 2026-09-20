import RewardsNameSetting from './components/RewardsNameSetting';
import BotPersonaSetting from './components/BotPersonaSetting';
import ConnectionsSetting from './components/ConnectionsSetting';
import styles from './components/Settings.module.css';
import { KNOWALL_CONSTANTS } from './constants/branding';

const Settings: React.FC = () => {
  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Settings</h1>
        <p className={styles.pageCredit}>Built by {KNOWALL_CONSTANTS.name}</p>
      </header>
      <RewardsNameSetting />
      <BotPersonaSetting />
      <ConnectionsSetting />
    </div>
  );
};

export default Settings;
