import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { ScrollToTop } from './ScrollToTop';

describe('ScrollToTop', () => {
  it('scrolls the window back to the top on every route change', async () => {
    const user = userEvent.setup();
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});

    render(
      <MemoryRouter initialEntries={['/']}>
        <ScrollToTop />
        <Routes>
          <Route path="/" element={<Link to="/systems/debian">Debian page</Link>} />
          <Route path="/systems/:slug" element={<p>System page</p>} />
        </Routes>
      </MemoryRouter>,
    );

    scrollTo.mockClear();
    await user.click(screen.getByRole('link', { name: 'Debian page' }));

    expect(screen.getByText('System page')).toBeTruthy();
    expect(scrollTo).toHaveBeenCalledWith(0, 0);

    scrollTo.mockRestore();
  });
});
