import React from 'react';
import { useTeamsAuth } from '../hooks/useTeamsAuth';

export const SignOutButton = () => {
  const { handleLogout, isLoggingOut } = useTeamsAuth();

  const onClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    handleLogout();
  };

  return (
    <button
      onClick={onClick}
      disabled={isLoggingOut}
      style={{
        background: 'none',
        border: 'none',
        padding: 0,
        color: 'inherit',
        font: 'inherit',
        textDecoration: 'none',
        cursor: isLoggingOut ? 'not-allowed' : 'pointer',
        opacity: isLoggingOut ? 0.6 : 1,
      }}
      onMouseEnter={e => {
        if (!isLoggingOut) {
          (e.target as HTMLElement).style.textDecoration = 'underline';
        }
      }}
      onMouseLeave={e => {
        (e.target as HTMLElement).style.textDecoration = 'none';
      }}
      title="Sign Out"
      aria-label="Sign Out"
    >
      {isLoggingOut ? 'Signing out...' : 'Sign Out'}
    </button>
  );
};

export default SignOutButton;
