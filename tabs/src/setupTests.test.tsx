// setupTests.test.tsx
import '@testing-library/jest-dom';
import { 
  expect, 
  describe, 
  test,
 } from '@jest/globals';

describe('Jest DOM Setup', () => {
  test('jest-dom is properly configured', () => {
    const div = document.createElement('div');
    div.textContent = 'React Testing';
    expect(div).toHaveTextContent(/react/i);
  });
});
