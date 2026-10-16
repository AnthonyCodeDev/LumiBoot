import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Topbar } from './Topbar';

function renderTopbar(initialEntries: string[] = ['/']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Topbar />
    </MemoryRouter>,
  );
}

describe('Topbar', () => {
  it('affiche le wordmark, la navigation principale et le CTA catalogue', () => {
    renderTopbar();
    expect(screen.getByRole('link', { name: 'LumiBoot, accueil' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Navigation principale' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Accueil' }).getAttribute('href')).toBe('/');
    expect(screen.getByRole('link', { name: 'Catalogue' }).getAttribute('href')).toBe('/#catalogue');
    expect(screen.getByRole('link', { name: 'Explorer le catalogue' }).getAttribute('href')).toBe(
      '/#catalogue',
    );
  });

  it('marque Accueil comme page courante sur /', () => {
    renderTopbar(['/']);
    expect(screen.getByRole('link', { name: 'Accueil' }).getAttribute('aria-current')).toBe('page');
  });

  it('ouvre et ferme le menu burger au clavier (Escape)', async () => {
    const user = userEvent.setup();
    renderTopbar(['/']);
    const toggle = screen.getByRole('button', { name: /menu de navigation/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await user.keyboard('{Escape}');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
});
