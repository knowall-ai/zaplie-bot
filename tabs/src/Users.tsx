import React from 'react';
import UserListComponent from './components/UserListComponent';

const Users: React.FC = () => {
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
          paddingLeft: 20,
          paddingRight: 20,
          paddingBottom: 20,
          paddingTop: 0,
        }}
      >
        <UserListComponent />
      </div>
    </div>
  );
};

export default Users;
