import { useEffect } from 'react';
import {
  AuthenticatedTemplate,
  UnauthenticatedTemplate,
  useMsal,
} from '@azure/msal-react';
import { Image, IRawStyle, Text } from '@fluentui/react';
import SignInSignOutButton from './components/SignInSignOutButton';
import { useNavigate } from 'react-router-dom';
import './styles/Home.css';
import KnowAllLogo from './images/KnowAllAI_Logo.png';

const centeredImageStyle: IRawStyle = {
  display: 'block',
  maxWidth: '100%',
  height: '42px',
  top: '100px',
  objectFit: 'cover',
  overflow: 'hidden',
  flexShrink: 0,
  margin: 'auto',
  paddingBottom: '80px',
  filter: 'brightness(0) invert(1)',
};

export function Login() {
  const { accounts } = useMsal();
  const navigate = useNavigate();

  useEffect(() => {
    if (accounts.length > 0) {
      navigate('/feed');
    }
  }, [accounts, navigate]);

  return (
    <div className="home-container">
      <div className="overlay"></div>
      <div className="content">
        <Image
          src={KnowAllLogo}
          styles={{ root: centeredImageStyle }}
          alt="KnowAll AI"
          width="10%"
        />
        <AuthenticatedTemplate>
          <Text styles={{ root: { color: 'white' } }}>Opening your feed…</Text>
        </AuthenticatedTemplate>
        <UnauthenticatedTemplate>
          <Text
            styles={{
              root: {
                color: '#84cc16',
                fontSize: '4vw',
                fontWeight: 'bold',
                lineHeight: '64px',
              },
            }}
          >
            Zaplie
          </Text>
          <Text
            styles={{
              root: {
                textAlign: 'center',
                marginTop: '100px',
                color: 'white',
                fontSize: '14px',
                display: 'block',
                lineHeight: '18px',
                paddingBottom: '80px',
              },
            }}
          >
            <p>
              Boost collaboration, reward achievements, incentivize improvement,
              and drive real value with Zaps.
            </p>
            <p>
              To get started, please log in to access your dashboard, manage
              your rewards, and start recognizing your teammates' efforts.
            </p>
            <p>Log in now to power up your workplace!</p>
            <br></br>
          </Text>
          <SignInSignOutButton />
        </UnauthenticatedTemplate>
      </div>
    </div>
  );
}

export default Login;
