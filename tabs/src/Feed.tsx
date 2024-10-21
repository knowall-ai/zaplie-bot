import React, { useState } from 'react';
import FeedComponent from './components/FeedComponent';
import ZapActivityChartComponent from './components/ZapActivityChartComponent';
import TotalZapsComponent from './components/TotalZapsComponent';

const Home: React.FC = () => {
  //const inKey = 'a77d1194b4f348b1a61e4e2938b5762f'; // TODO: Hardcoded to Ben's Allowance wallet for now.
  const [timestamp] = useState(() => {
    return Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 365 * (8.5 / 12); // Last 8.5 months
  });

  return (
    <div style={{ background: '#1F1F1F', paddingBottom: 40 }}>
      <div
        style={{
          width: '100%',
          height: '100%',
          padding: 20,
          //background: '#1F1F1F',
          justifyContent: 'flex-start',
          alignItems: 'flex-start',
          gap: 918,
          display: 'inline-flex',
        }}
      >
        <div
          style={{
            /*height: 246.19,*/
            justifyContent: 'flex-start',
            alignItems: 'flex-start',
            gap: 6,
            display: 'flex',
          }}
        >
          <TotalZapsComponent/>
          <ZapActivityChartComponent lnKey={''} timestamp={timestamp} />
        </div>
      </div>
      <div
        style={{
          paddingLeft: 20,
          paddingRight: 20,
          paddingBottom: 20,
          paddingTop: 0,
        }}
      >
        <FeedComponent />
      </div>
    </div>
  );
};

export default Home;
