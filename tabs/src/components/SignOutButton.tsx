import { useState } from "react";
import { useMsal } from "@azure/msal-react";
import { IconButton, ContextualMenu, IContextualMenuProps, IIconProps } from '@fluentui/react';

const accountCircleIcon: IIconProps = { iconName: 'Contact' };

export const SignOutButton = () => {
    const { instance } = useMsal();

    const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
    const open = Boolean(anchorEl);

    const handleLogout = (logoutType: string) => {
        setAnchorEl(null);

        if (logoutType === "popup") {
            instance.logoutPopup({
                mainWindowRedirectUri: "/"
            });
        } else if (logoutType === "redirect") {
            instance.logoutRedirect();
        }
    }

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
              handleLogout('popup');
            }}
            style={{ textDecoration: 'none', cursor: 'pointer'}}
            title="Sign Out"
            aria-label="Sign Out"
          >            
              Sign Out

          </a>
          {open && <ContextualMenu {...menuProps} />}
        </div>
      );
    };
    