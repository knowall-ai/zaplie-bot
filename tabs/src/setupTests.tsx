// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';

// Pinned here, not in a .env, so a developer's real node URL can never leak in.
process.env.REACT_APP_LNBITS_NODE_URL = 'https://lnbits.test';
process.env.REACT_APP_LNBITS_USERNAME = 'test-user';
process.env.REACT_APP_LNBITS_PASSWORD = 'test-password';
