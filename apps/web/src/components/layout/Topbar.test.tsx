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
  it('affiche le wordmark et le CTA Discord', () => {
    renderTopbar();
    expect(screen.getByRole('link', { name: 'LumiBoot, accueil' })).toBeTruthy();
    const discord = screen.getByRole('link', { name: 'Rejoindre le Discord' });
    expect(discord.getAttribute('href')).toBe('https://discord.gg/HcqduKt');
    expect(discord.getAttribute('target')).toBe('_blank');
    expect(discord.getAttribute('rel')).toBe('noopener noreferrer');
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
