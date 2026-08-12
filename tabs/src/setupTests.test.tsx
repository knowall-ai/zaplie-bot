// setupTests.test.tsx
import '@testing-library/jest-dom';

describe('Jest DOM Setup', () => {
  test('jest-dom is properly configured', () => {
    const div = document.createElement('div');
    div.textContent = 'React Testing';
    expect(div).toHaveTextContent(/react/i);
  });
});
