import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { ScrollToTop } from './ScrollToTop';

describe('ScrollToTop', () => {
  it('remonte la fenêtre en haut à chaque changement de route', async () => {
    const user = userEvent.setup();
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});

    render(
      <MemoryRouter initialEntries={['/']}>
        <ScrollToTop />
        <Routes>
          <Route path="/" element={<Link to="/systems/debian">Fiche Debian</Link>} />
          <Route path="/systems/:slug" element={<p>Fiche système</p>} />
        </Routes>
      </MemoryRouter>,
    );

    scrollTo.mockClear();
    await user.click(screen.getByRole('link', { name: 'Fiche Debian' }));

    expect(screen.getByText('Fiche système')).toBeTruthy();
    expect(scrollTo).toHaveBeenCalledWith(0, 0);

    scrollTo.mockRestore();
  });
});
