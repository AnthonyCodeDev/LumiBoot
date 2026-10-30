import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { getDisplaySystems, getSystemById, systems } from '@lumiboot/catalog';
import type { Availability } from '@lumiboot/contracts';
import { SystemGrid } from './SystemGrid';
import { availabilityLabels } from '../../lib/labels';
import { useCatalogStore } from '../../features/catalog/catalog.store';

const displayedCount = getDisplaySystems().length;

const PLAYABLE: ReadonlySet<Availability> = new Set(['ready', 'resource-required']);

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
    architectures: [],
    engines: [],
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
    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.getAttribute('data-id')).toBe('debian-12-i386');
  });

  it('shows canonical architecture labels and the parent synthesis', () => {
    renderGrid();
    const card = (id: string) =>
      screen.getAllByRole('article').find((article) => article.getAttribute('data-id') === id)!;

    expect(within(card('alpine-3-24-x86-64')).getByText('3.24 · 64 bits')).toBeTruthy();
    expect(within(card('debian-12-i386')).getByText('12 Bookworm · 32 bits')).toBeTruthy();
    expect(within(card('ubuntu-18-i386')).getByText('18.04 LTS · 32 bits')).toBeTruthy();
    expect(within(card('windows-7-x86')).getByText('32 bits')).toBeTruthy();
    expect(within(card('windows-11-x64')).getByText('64 bits')).toBeTruthy();
    expect(within(card('windows-10-x86')).getByText('32 bits')).toBeTruthy();
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

  it('orders playable cards before the pending ones', () => {
    renderGrid();
    const availabilities = screen.getAllByRole('article').map((card) => {
      const id = card.getAttribute('data-id');
      return getSystemById(id!)!.availability;
    });
    let seenPending = false;
    for (const availability of availabilities) {
      if (PLAYABLE.has(availability)) {
        expect(seenPending).toBe(false);
      } else {
        seenPending = true;
      }
    }
  });

  it('renders a separator between the playable systems and the others', () => {
    renderGrid();
    expect(screen.getByRole('separator').tagName).toBe('HR');
  });

  it('omits the separator when only one group is visible', () => {
    renderGrid();
    act(() => {
      useCatalogStore.getState().setFamily('custom');
    });
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('applies the is-muted class only to pending cards', () => {
    renderGrid();
    const cards = screen.getAllByRole('article');
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      const id = card.getAttribute('data-id');
      const system = getSystemById(id!)!;
      const isMuted = card.classList.contains('is-muted');
      expect(isMuted).toBe(!PLAYABLE.has(system.availability));
      if (system.availability === 'ready' || system.availability === 'resource-required') {
        expect(isMuted).toBe(false);
      }
    }
  });

  it('keeps the generic "Custom image" card in the first, non-muted group', () => {
    renderGrid();
    const card = screen.getAllByRole('article').find((article) => {
      return article.getAttribute('data-id') === 'custom-image';
    });
    expect(card).toBeDefined();
    expect(card!.classList.contains('is-muted')).toBe(false);
    expect(getSystemById('custom-image')!.availability).toBe('resource-required');
    const group = card!.closest('.cards');
    expect(group).not.toBeNull();
    expect(group!.querySelector('.is-muted')).toBeNull();
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
    expect(screen.getByTestId('location').textContent).toBe('/systems/debian-12-i386');
  });
});
