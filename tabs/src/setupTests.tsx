import '@testing-library/jest-dom';
import { TextDecoder, TextEncoder } from 'util';

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

// jsdom does not provide TextDecoder/TextEncoder, which @scure/base needs to
// decode a real BOLT11 invoice. Without these the Lightning tests can only run
// against a mocked decoder, which is exactly the coverage gap they exist to
// close.
if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder =
    TextDecoder as unknown as typeof globalThis.TextDecoder;
}
if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder =
    TextEncoder as unknown as typeof globalThis.TextEncoder;
}
