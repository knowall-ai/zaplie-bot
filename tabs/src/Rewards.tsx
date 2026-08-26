import React from 'react';
import RewardsComponent from './components/RewardsComponent';
import './App.css';

const Rewards: React.FC = () => {
  return (
    <div
      style={{
        background: 'var(--surface-page)',
        marginTop: 20,
        marginBottom: 40,
      }}
    >
      <div
        style={{
          paddingLeft: 'var(--space-4)',
          paddingRight: 'var(--space-4)',
          paddingBottom: 'var(--space-4)',
          paddingTop: 0,
        }}
      >
        <RewardsComponent />
      </div>
    </div>
  );
};

export default Rewards;
