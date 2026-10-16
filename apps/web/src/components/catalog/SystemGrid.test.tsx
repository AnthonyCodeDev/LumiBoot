import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { getDisplaySystems, getSystemById, systems } from '@lumiboot/catalog';
import { SystemGrid } from './SystemGrid';
import { availabilityLabels } from '../../lib/labels';
import { useCatalogStore } from '../../features/catalog/catalog.store';

/**
 * Nombre de cartes attendues : une par système AFFICHÉ (mères de groupe +
 * autonomes). Les variantes enfants n'ont pas leur propre carte.
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
  it('affiche une seule carte par système affiché (mères + autonomes)', () => {
    renderGrid();
    expect(screen.getAllByRole('article')).toHaveLength(displayedCount);
  });

  it('replie les variantes sur une seule carte Debian lors de la recherche', () => {
    renderGrid();
    act(() => {
      useCatalogStore.getState().setQuery('debian');
    });
    // Debian console, Bureau et XFCE matchent « debian », mais la grille ne
    // montre que la carte de la mère : une seule carte.
    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.getAttribute('data-id')).toBe('debian-12-i386');
  });

  it('affiche un état vide et le réinitialise', async () => {
    const user = userEvent.setup();
    renderGrid();
    act(() => {
      useCatalogStore.getState().setQuery('aucun-systeme-correspondant');
    });
    expect(screen.queryAllByRole('article')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Réinitialiser les filtres' }));
    expect(screen.getAllByRole('article')).toHaveLength(displayedCount);
  });

  it('affiche le badge de statut de disponibilité sur chaque carte', () => {
    renderGrid();
    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(displayedCount);
    for (const card of cards) {
      // On ne recode pas la disponibilité en dur : on la lit dans le catalogue.
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

  it('ordonne les cartes disponibles avant les non-disponibles', () => {
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

  it('affiche un séparateur entre les systèmes disponibles et les autres', () => {
    renderGrid();
    expect(screen.getByRole('separator').tagName).toBe('HR');
  });

  it('applique la classe is-muted uniquement aux cartes non-disponibles', () => {
    renderGrid();
    const cards = screen.getAllByRole('article');
    for (const card of cards) {
      const id = card.getAttribute('data-id');
      const system = getSystemById(id!)!;
      const isMuted = card.classList.contains('is-muted');
      expect(isMuted).toBe(system.availability !== 'ready');
    }
  });

  it('navigue directement vers la fiche système au clic (sans popup)', async () => {
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

  it('ouvre la mère/base (Debian) au clic sur la carte Debian', async () => {
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
    // La carte ouvre la mère : la variante se choisit ensuite sur la fiche.
    expect(screen.getByTestId('location').textContent).toBe('/systems/debian-12-i386');
  });
});
