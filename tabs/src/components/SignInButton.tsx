import { useState } from 'react';
import { useMsal } from '@azure/msal-react';
import {
  DefaultButton,
  ContextualMenu,
  IContextualMenuProps,
} from '@fluentui/react';
import { loginRequest } from '../services/authConfig';

export const SignInButton = () => {
  const { instance } = useMsal();

  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const open = Boolean(anchorEl);

  const handleLogin = async (loginType: string) => {
    console.log('Login type: ', loginType);
    try {
      setAnchorEl(null);

      if (loginType === 'popup') {
        await instance.loginPopup({ ...loginRequest, prompt: 'login' });
      } else if (loginType === 'redirect') {
        await instance.loginRedirect({ ...loginRequest, prompt: 'login' });
      }
    } catch (error: any) {
      if (error.errorCode === 'user_cancelled') {
        console.warn('Login was cancelled. Please try again.');
      } else {
        console.warn('An error occurred during login. Please try again.');
        console.error('Login error:', error);
      }
    }
  };

  const menuProps: IContextualMenuProps = {
    items: [
      {
        key: 'popup',
        text: 'Login with Popup',
        onClick: () => {
          handleLogin('popup');
          return undefined; // Ensure the callback is synchronous and returns void
        },
      },
      {
        key: 'redirect',
        text: 'Login with Redirect',
        onClick: () => {
          handleLogin('redirect');
          return undefined; // Ensure the callback is synchronous and returns void
        },
      },
    ],
    directionalHintFixed: true,
    target: anchorEl,
    onDismiss: () => setAnchorEl(null),
  };

  return (
    <div>
      <DefaultButton
        text="Sign In"
        onClick={() => handleLogin('popup')}
        styles={{
          root: {
            color: 'black',
            width: 'auto',
            lineHeight: '20px',
            fontWeight: 600,
          },
        }}
      />
      {open && <ContextualMenu {...menuProps} />}
    </div>
  );
};
