import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { getSystemById, systems } from '@lumiboot/catalog';
import { SystemGrid } from './SystemGrid';
import { availabilityLabels } from '../../lib/labels';
import { useCatalogStore } from '../../features/catalog/catalog.store';

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
  it('affiche toutes les cartes du catalogue', () => {
    renderGrid();
    expect(screen.getAllByRole('article')).toHaveLength(systems.length);
  });

  it('filtre les cartes selon la recherche', () => {
    renderGrid();
    act(() => {
      useCatalogStore.getState().setQuery('debian');
    });
    // Debian (console), Debian (Bureau) et Debian (XFCE) correspondent à « debian ».
    expect(screen.getAllByRole('article')).toHaveLength(3);
  });

  it('affiche un état vide et le réinitialise', async () => {
    const user = userEvent.setup();
    renderGrid();
    act(() => {
      useCatalogStore.getState().setQuery('aucun-systeme-correspondant');
    });
    expect(screen.queryAllByRole('article')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Réinitialiser les filtres' }));
    expect(screen.getAllByRole('article')).toHaveLength(systems.length);
  });

  it('affiche le badge de statut de disponibilité sur chaque carte', () => {
    renderGrid();
    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(systems.length);
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
});
