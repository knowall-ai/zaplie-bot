import React, { useState } from 'react';
import CurrencySetting from './components/RewardsNameSetting'
import styles from './components/setting.module.css';

const Settings: React.FC = () => {


  return (
<div className={styles.mainContainer}>
  <div className={styles.title}>
    Settings <span style={{ fontSize: '12px', color: '#666', marginLeft: '10px' }}>Built by KnowAll AI</span>
  </div>
  <div style={{ width: '100%' }}> <CurrencySetting /> </div>
</div>
  );
};

export default Settings;
