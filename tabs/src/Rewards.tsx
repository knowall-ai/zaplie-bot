import React from 'react';
import RewardsComponent from './components/RewardsComponent';
import './App.css';

const Rewards: React.FC = () => {
  return (
    <div
      style={{
        background: '#1F1F1F',
        marginTop: 20,
        marginBottom: 40,
      }}
    >
      <div
        style={{
          paddingLeft: 20,
          paddingRight: 20,
          paddingBottom: 20,
          paddingTop: 0,
        }}
      >
        <RewardsComponent />
      </div>
    </div>
  );
};

export default Rewards;
