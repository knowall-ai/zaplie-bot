import React, { useState } from 'react';
import CurrencySetting from './components/RewardsNameSetting'
import styles from './components/setting.module.css';
import ProvidedBy from './images/ProvidedBy.svg';

const Settings: React.FC = () => {


  return ( 
<div className={styles.mainContainer}>
  <div className={styles.title}>
    Settings <img src={ProvidedBy} alt="Provided By" className={styles.providedByImage} />
  </div>
  <div style={{ width: '100%' }}> <CurrencySetting /> </div>
</div>
  );
};

export default Settings;
