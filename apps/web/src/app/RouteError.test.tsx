import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { RouteError } from './RouteError';

function Boom(): never {
  throw new Error('simulated render failure');
}

function renderErrorRouter() {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <Boom />,
        errorElement: <RouteError />,
      },
    ],
    { initialEntries: ['/'] },
  );
  return render(<RouterProvider router={router} />);
}

describe('RouteError', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('shows a friendly page with a link back to the library', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    renderErrorRouter();

    expect(await screen.findByRole('heading', { name: /Something went wrong/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to the library' }).getAttribute('href')).toBe(
      '/',
    );
    expect(screen.getByRole('button', { name: 'Reload the page' })).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('does not expose technical details outside development', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('DEV', false);

    renderErrorRouter();

    expect(await screen.findByRole('heading', { name: /Something went wrong/ })).toBeTruthy();
    expect(screen.queryByText('simulated render failure')).toBeNull();
  });
});
