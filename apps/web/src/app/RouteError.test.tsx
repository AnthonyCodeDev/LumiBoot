import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { RouteError } from './RouteError';

function Boom(): never {
  throw new Error('échec de rendu simulé');
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

  it('affiche une page conviviale avec un lien de retour à la bibliothèque', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    renderErrorRouter();

    expect(await screen.findByRole('heading', { name: /Oups, quelque chose/ })).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Retour à la bibliothèque' }).getAttribute('href'),
    ).toBe('/');
    expect(screen.getByRole('button', { name: 'Recharger la page' })).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it("n'expose pas le détail technique hors développement", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('DEV', false);

    renderErrorRouter();

    expect(await screen.findByRole('heading', { name: /Oups, quelque chose/ })).toBeTruthy();
    expect(screen.queryByText('échec de rendu simulé')).toBeNull();
  });
});
