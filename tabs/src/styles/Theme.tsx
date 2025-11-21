import { createTheme } from '@fluentui/react';

// Create a theme instance.
export const theme = createTheme({
  palette: {
    themePrimary: '#84cc16',
    themeSecondary: '#84cc16',
    themeDarkAlt: '#6ba513',
    themeDark: '#4d7a0c',
    themeDarker: '#3a5e09',
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

          backgroundColor: '#84cc16',
          color: '#1f1f1f',
          border: 'none',
          width:'150px',
          height:'50px',
          selectors: {
            ':hover': {
              backgroundColor: '#6ba513',
              color: '#fff',
            },
          },
        },
      },
    },
    PrimaryButton: {
      styles: {
        root: {

          backgroundColor: '#84cc16',
          color: '#1f1f1f',
          border: 'none',
          selectors: {
            ':hover': {
              backgroundColor: '#6ba513',
              color: '#fff',
            },
          },
        },
      },
    },
  },
});