import React from 'react';
import WeekComponent from './components/WeekComponent';
import './App.css';
import styles from './Week.module.css';

const Week: React.FC = () => {
  return (
    <main className={styles.page}>
      <div className={styles.content}>
        <WeekComponent />
      </div>
    </main>
  );
};

export default Week;
