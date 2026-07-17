import React from 'react';
import WeekComponent from './components/WeekComponent';
import './App.css';

const Week: React.FC = () => {
  return (
    <div style={{ background: '#1F1F1F', marginTop: 20, marginBottom: 40 }}>
      <div style={{ paddingLeft: 20, paddingRight: 20, paddingBottom: 20, paddingTop: 0 }}>
        <WeekComponent />
      </div>
    </div>
  );
};

export default Week;
