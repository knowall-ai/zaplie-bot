import { useState } from 'react';
import { useMsal } from '@azure/msal-react';
import { ContextualMenu, IContextualMenuProps } from '@fluentui/react';

export const SignOutButton = () => {
  const { instance } = useMsal();

  const [isHovered, setIsHovered] = useState(false); // State to track hover
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const open = Boolean(anchorEl);

  const handleLogout = (logoutType: string) => {
    setAnchorEl(null);

    if (logoutType === 'popup') {
      instance.logoutPopup({
        mainWindowRedirectUri: '/',
      });
    } else if (logoutType === 'redirect') {
      instance.logoutRedirect();
    }
  };


    const menuProps: IContextualMenuProps = {
        items: [
            {
                key: 'logoutPopup',
                text: 'Logout using Popup',
                onClick: () => handleLogout("popup")
            },
            {
                key: 'logoutRedirect',
                text: 'Logout using Redirect',
                onClick: () => handleLogout("redirect")
            }
        ],
        onDismiss: () => setAnchorEl(null),
        target: anchorEl,
        directionalHint: 4, // topRightEdge
        isBeakVisible: true,
    };

    return (
        <div style={{ display: 'inline' }}>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              handleLogout('redirect');
            }}
            style={{ textDecoration: 'none', cursor: 'pointer'}}
            title="Sign Out"
            aria-label="Sign Out"
          >            
              Sign Out


  return (
    <div style={{ display: 'inline' }}>
      <button
        onMouseEnter={() => setIsHovered(true)} // Set hover state on mouse enter
        onMouseLeave={() => setIsHovered(false)} // Remove hover state on mouse leave
        onClick={e => {
          e.preventDefault();
          handleLogout('popup');
        }}
        style={{
          display: 'inline-block',
          textDecoration: isHovered ? 'underline' : 'none', // Underline on hover
          cursor: 'pointer',
          background: 'none',
          border: 'none',
          color: 'inherit',
          padding: 0,
          font: 'inherit',
          width: 'auto',
        }}
        title="Sign Out"
        aria-label="Sign Out"
      >
        Sign Out
      </button>
      {open && <ContextualMenu {...menuProps} />}
    </div>
  );
};
