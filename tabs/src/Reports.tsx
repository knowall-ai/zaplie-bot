import React from 'react';
import ReportsComponent from './components/ReportsComponent';
import './App.css';

const Reports: React.FC = () => {
  return (
    <div
      style={{
        background: '#1F1F1F',
        marginTop: 20,
        marginBottom: 40,
        alignSelf: 'stretch',
        width: '100%',
        boxSizing: 'border-box',
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
        <ReportsComponent />
      </div>
    </div>
  );
};

export default Reports;
