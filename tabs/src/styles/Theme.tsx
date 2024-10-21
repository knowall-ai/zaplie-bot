import { createTheme } from '@fluentui/react';

// Create a theme instance.
export const theme = createTheme({
  palette: {
    themePrimary: '#686868',
    themeSecondary: '#19857b',
    themeDarkAlt: '#505050',
    themeDark: '#3b3b3b',
    themeDarker: '#2c2c2c',
    neutralPrimary: '#fff',
    neutralLighter: '#1f1f1f',
    neutralLight: '#2b2b2b',
    neutralQuaternaryAlt: '#373737',
    neutralQuaternary: '#3f3f3f',
    neutralTertiaryAlt: '#595959',
    neutralTertiary: '#a6a6a6',
    neutralSecondary: '#d0d0d0',
    neutralPrimaryAlt: '#dadada',
    neutralDark: '#f4f4f4',
    black: '#f8f8f8',
    white: '#1f1f1f',
  },
  fonts: {
    small: {
      fontSize: '10px',
    },
    medium: {
      fontSize: '14px',
    },
    large: {
      fontSize: '18px',
    },
    xLarge: {
      fontSize: '24px',
    },
  },
  components: {
    DefaultButton: {
      styles: {
        root: {
         
          backgroundColor: '#F2A900',
          color: 'f4f4f4',
          border: 'none',
          width:'150px',
          height:'50px',
          selectors: {
            ':hover': {
              backgroundColor: '#505050',
              color: '#fff',
            },
          },
        },
      },
    },
    PrimaryButton: {
      styles: {
        root: {
         
          backgroundColor: '#19857b',
          color: '#fff',
          border: 'none',
          selectors: {
            ':hover': {
              backgroundColor: '#146a63',
              color: '#fff',
            },
          },
        },
      },
    },
  },
});