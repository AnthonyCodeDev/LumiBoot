import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { getDisplaySystems, getSystemById, systems } from '@lumiboot/catalog';
import { SystemGrid } from './SystemGrid';
import { availabilityLabels } from '../../lib/labels';
import { useCatalogStore } from '../../features/catalog/catalog.store';

/**
 * Expected card count: one per DISPLAYED system (group parents + standalone
 * systems). Child variants have no card of their own.
 */
const displayedCount = getDisplaySystems().length;

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{location.pathname}</p>;
}

function renderGrid() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <SystemGrid />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useCatalogStore.setState({
    systems,
    family: 'all',
    query: '',
  });
});

describe('SystemGrid', () => {
  it('renders a single card per displayed system (parents + standalone)', () => {
    renderGrid();
    expect(screen.getAllByRole('article')).toHaveLength(displayedCount);
  });

  it('folds the variants into a single Debian card during search', () => {
    renderGrid();
    act(() => {
      useCatalogStore.getState().setQuery('debian');
    });
    // Debian console, Desktop and XFCE match "debian", but the grid only shows
    // the parent card: a single card.
    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.getAttribute('data-id')).toBe('debian-12-i386');
  });

  it('renders an empty state and resets it', async () => {
    const user = userEvent.setup();
    renderGrid();
    act(() => {
      useCatalogStore.getState().setQuery('no-matching-system');
    });
    expect(screen.queryAllByRole('article')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(screen.getAllByRole('article')).toHaveLength(displayedCount);
  });

  it('renders the availability badge on every card', () => {
    renderGrid();
    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(displayedCount);
    for (const card of cards) {
      // Availability is not hard-coded here: it is read from the catalogue.
      const id = card.getAttribute('data-id');
      const system = id ? getSystemById(id) : null;
      expect(system).not.toBeNull();
      const availability = system!.availability;
      const expected = availabilityLabels[availability];
      const badge = within(card).getByText(expected);
      expect(badge.getAttribute('data-state')).toBe(availability);
      expect(badge.className).toContain('card-status');
    }
  });

  it('orders available cards before unavailable ones', () => {
    renderGrid();
    const availabilities = screen.getAllByRole('article').map((card) => {
      const id = card.getAttribute('data-id');
      return getSystemById(id!)!.availability;
    });
    let seenUnavailable = false;
    for (const availability of availabilities) {
      if (availability !== 'ready') {
        seenUnavailable = true;
      } else {
        expect(seenUnavailable).toBe(false);
      }
    }
  });

  it('renders a separator between available systems and the others', () => {
    renderGrid();
    expect(screen.getByRole('separator').tagName).toBe('HR');
  });

  it('applies the is-muted class only to unavailable cards', () => {
    renderGrid();
    const cards = screen.getAllByRole('article');
    for (const card of cards) {
      const id = card.getAttribute('data-id');
      const system = getSystemById(id!)!;
      const isMuted = card.classList.contains('is-muted');
      expect(isMuted).toBe(system.availability !== 'ready');
    }
  });

  it('navigates straight to the system page on click (no popup)', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/']}>
        <SystemGrid />
        <LocationProbe />
      </MemoryRouter>,
    );
    await user.click(screen.getAllByRole('article')[0] as HTMLElement);
    expect(screen.getByTestId('location').textContent).toMatch(/^\/systems\//);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the base/parent (Debian) when the Debian card is clicked', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/']}>
        <SystemGrid />
        <LocationProbe />
      </MemoryRouter>,
    );
    const card = screen
      .getAllByRole('article')
      .find((article) => article.getAttribute('data-id') === 'debian-12-i386');
    expect(card).toBeDefined();
    await user.click(card as HTMLElement);
    // The card opens the parent: the variant is then picked on its page.
    expect(screen.getByTestId('location').textContent).toBe('/systems/debian-12-i386');
  });
});
