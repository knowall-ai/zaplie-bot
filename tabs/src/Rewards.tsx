import React from 'react';
import RewardsComponent from './components/RewardsComponent';
import './App.css';
const adminKey = process.env.REACT_APP_LNBITS_ADMINKEY as string;

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
        <RewardsComponent
          adminKey={adminKey}
          userId={'2984e3ac627e4fea9fd6dde9c4df83b5'}
        />
      </div>
    </div>
  );
};

export default Rewards;
