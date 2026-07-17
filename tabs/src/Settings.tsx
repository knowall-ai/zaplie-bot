import CurrencySetting from './components/RewardsNameSetting'
import BotPersonaSetting from './components/BotPersonaSetting';
import RewardAmountsSetting from './components/RewardAmountsSetting';
import styles from './components/setting.module.css';
import { KNOWALL_CONSTANTS } from './constants/branding';

const Settings: React.FC = () => {
  return (
<div className={styles.mainContainer}>
  <div className={styles.title}>
    Settings <span className={styles.providedBy}>Built by {KNOWALL_CONSTANTS.name}</span>
  </div>
  <div style={{ width: '100%' }}> <CurrencySetting /> </div>
  <div className={styles.title}>Admin</div>
  <div style={{ width: '100%' }}> <BotPersonaSetting /> </div>
  <div style={{ width: '100%' }}> <RewardAmountsSetting /> </div>
</div>
  );
};

export default Settings;
