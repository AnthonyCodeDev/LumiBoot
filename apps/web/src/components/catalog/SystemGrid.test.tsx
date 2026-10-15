import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { systems } from '@lumiboot/catalog';
import { SystemGrid } from './SystemGrid';
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
  it('affiche les neuf cartes du catalogue', () => {
    renderGrid();
    expect(screen.getAllByRole('article')).toHaveLength(9);
  });

  it('filtre les cartes selon la recherche', () => {
    renderGrid();
    act(() => {
      useCatalogStore.getState().setQuery('debian');
    });
    // Debian (console) et Debian (Bureau) correspondent à « debian ».
    expect(screen.getAllByRole('article')).toHaveLength(2);
  });

  it('affiche un état vide et le réinitialise', async () => {
    const user = userEvent.setup();
    renderGrid();
    act(() => {
      useCatalogStore.getState().setQuery('aucun-systeme-correspondant');
    });
    expect(screen.queryAllByRole('article')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Réinitialiser les filtres' }));
    expect(screen.getAllByRole('article')).toHaveLength(9);
  });

  it('affiche le badge de statut de disponibilité sur chaque carte', () => {
    renderGrid();
    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(9);
    for (const card of cards) {
      // Seul le profil console Debian 12 i386 a prouvé un vrai boot (Lot 2) :
      // badge « Disponible ». La variante Bureau reste « En préparation ».
      const isReadyConsole = card.getAttribute('data-id') === 'debian-12-i386';
      const expected = isReadyConsole ? 'Disponible' : 'En préparation';
      const badge = within(card).getByText(expected);
      expect(badge.getAttribute('data-state')).toBe(isReadyConsole ? 'ready' : 'planned');
      expect(badge.className).toContain('card-status');
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
