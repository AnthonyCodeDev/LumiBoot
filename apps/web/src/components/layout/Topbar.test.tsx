import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Topbar } from './Topbar';
import { DISCORD_INVITE_URL } from '../../config/environment';

function renderTopbar(initialEntries: string[] = ['/']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Topbar />
    </MemoryRouter>,
  );
}

describe('Topbar', () => {
  it('renders the wordmark and the Discord CTA', () => {
    renderTopbar();
    expect(screen.getByRole('link', { name: 'LumiBoot, home' })).toBeTruthy();
    const discord = screen.getByRole('link', { name: 'Join the Discord' });
    expect(discord.getAttribute('href')).toBe(DISCORD_INVITE_URL);
    expect(discord.getAttribute('target')).toBe('_blank');
    expect(discord.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('opens and closes the burger menu with the keyboard (Escape)', async () => {
    const user = userEvent.setup();
    renderTopbar(['/']);
    const toggle = screen.getByRole('button', { name: /navigation menu/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await user.keyboard('{Escape}');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
});
