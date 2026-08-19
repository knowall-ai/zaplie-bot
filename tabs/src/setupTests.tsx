import '@testing-library/jest-dom';

// jsdom ships no matchMedia, so components that read a breakpoint cannot render.
window.matchMedia = (query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }) as MediaQueryList;

process.env.REACT_APP_AAD_CLIENT_ID = '00000000-0000-4000-8000-000000000001';
process.env.REACT_APP_TENANT_ID = '00000000-0000-4000-8000-000000000002';
