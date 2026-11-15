import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ErrorBoundary from './ErrorBoundary';
import { ErrorState, NotFound } from './StatusPage';
import { ApiError } from '../utils/appErrors';

const mockReport = jest.fn();
jest.mock('../utils/appErrors', () => {
  const actual = jest.requireActual('../utils/appErrors');
  return {
    ...actual,
    reportClientError: (report: unknown) => mockReport(report),
  };
});

let container: HTMLDivElement;
let root: Root;
const mount = (element: React.ReactElement) => {
  root.render(element);
};
const render = async (element: React.ReactElement) => {
  await act(async () => {
    mount(element);
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.restoreAllMocks();
});

const Boom = ({ error }: { error: unknown }) => {
  throw error;
};

describe('Not found', () => {
  test('an unknown address shows the Not found page with a way back to the Feed', async () => {
    await render(
      <MemoryRouter initialEntries={['/no/such/page']}>
        <Routes>
          <Route path="/feed" element={<p>Feed page</p>} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(container.querySelector('h1')?.textContent).toBe('Page not found');
    expect(document.activeElement).toBe(container.querySelector('h1'));
    expect(container.querySelector('a[href="/feed"]')?.textContent).toBe(
      'Back to Feed',
    );
    expect(container.textContent).not.toContain('Feed page');
  });

  test('a valid deep link still renders its page', async () => {
    await render(
      <MemoryRouter initialEntries={['/feed']}>
        <Routes>
          <Route path="/feed" element={<p>Feed page</p>} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(container.textContent).toContain('Feed page');
  });
});

describe('ErrorBoundary', () => {
  test('a thrown render error shows the friendly page with a reference id, no stack', async () => {
    const error = new Error(
      'TypeError: cannot read secret of undefined at Wallet.tsx:42',
    );
    await render(
      <MemoryRouter>
        <ErrorBoundary>
          <Boom error={error} />
        </ErrorBoundary>
      </MemoryRouter>,
    );
    expect(container.querySelector('h1')?.textContent).toBe(
      'Something went wrong',
    );
    const reference =
      container.querySelector('[data-testid="reference-id"] strong')
        ?.textContent || '';
    expect(reference).toMatch(/^[A-Z2-9]{8}$/);
    expect(container.textContent).not.toContain('Wallet.tsx');
    expect(container.textContent).not.toContain('secret');
    expect(mockReport).toHaveBeenCalledWith(
      expect.objectContaining({ referenceId: reference, kind: 'render' }),
    );
  });

  test('a wallet outage and an ended session get their own states', async () => {
    await render(
      <MemoryRouter>
        <ErrorBoundary>
          <Boom
            error={new ApiError('The wallet service is unavailable', 503)}
          />
        </ErrorBoundary>
      </MemoryRouter>,
    );
    expect(container.querySelector('h1')?.textContent).toBe(
      'The wallet service is unreachable',
    );

    await render(
      <MemoryRouter>
        <ErrorBoundary key="session">
          <Boom error={new ApiError('invalid token', 401)} />
        </ErrorBoundary>
      </MemoryRouter>,
    );
    expect(container.querySelector('h1')?.textContent).toBe(
      'Please sign in again',
    );
    expect(container.querySelector('a[href="/login"]')).not.toBe(null);
  });

  test('moving to another page clears the error', async () => {
    await render(
      <MemoryRouter>
        <ErrorBoundary resetKey="/broken">
          <Boom error={new Error('x')} />
        </ErrorBoundary>
      </MemoryRouter>,
    );
    expect(container.querySelector('h1')?.textContent).toBe(
      'Something went wrong',
    );
    await render(
      <MemoryRouter>
        <ErrorBoundary resetKey="/feed">
          <p>Feed page</p>
        </ErrorBoundary>
      </MemoryRouter>,
    );
    expect(container.textContent).toContain('Feed page');
  });
});

describe('friendly states', () => {
  test('not a member and admins only offer no retry, only the way back', async () => {
    await render(
      <MemoryRouter>
        <ErrorState kind="not-member" />
      </MemoryRouter>,
    );
    expect(container.textContent).toContain('not available for this account');
    expect(
      Array.from(container.querySelectorAll('button')).map(
        button => button.textContent,
      ),
    ).toEqual([]);
    await render(
      <MemoryRouter>
        <ErrorState kind="forbidden" />
      </MemoryRouter>,
    );
    expect(container.querySelector('h1')?.textContent).toBe('Admins only');
  });
});
