import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { systems } from '@lumiboot/catalog';
import { SystemGrid } from './SystemGrid';
import { useCatalogStore } from '../../features/catalog/catalog.store';

beforeEach(() => {
  useCatalogStore.setState({
    systems,
    family: 'all',
    query: '',
    selectedId: null,
  });
});

describe('SystemGrid', () => {
  it('affiche les huit cartes du catalogue', () => {
    render(<SystemGrid />);
    expect(screen.getAllByRole('article')).toHaveLength(8);
  });

  it('filtre les cartes selon la recherche', () => {
    render(<SystemGrid />);
    act(() => {
      useCatalogStore.getState().setQuery('debian');
    });
    expect(screen.getAllByRole('article')).toHaveLength(1);
  });

  it('affiche un état vide et le réinitialise', async () => {
    const user = userEvent.setup();
    render(<SystemGrid />);
    act(() => {
      useCatalogStore.getState().setQuery('aucun-systeme-correspondant');
    });
    expect(screen.queryAllByRole('article')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Réinitialiser les filtres' }));
    expect(screen.getAllByRole('article')).toHaveLength(8);
  });

  it('affiche le badge de statut de disponibilité sur chaque carte', () => {
    render(<SystemGrid />);
    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(8);
    for (const card of cards) {
      // Debian 12 i386 a prouvé un vrai boot (Lot 2) : badge « Disponible ».
      // Tous les autres systèmes restent « En préparation ».
      const name = card.getAttribute('aria-label') ?? '';
      const expected = name.includes('Debian') ? 'Disponible' : 'En préparation';
      const badge = within(card).getByText(expected);
      expect(badge.getAttribute('data-state')).toBe(name.includes('Debian') ? 'ready' : 'planned');
      expect(badge.className).toContain('card-status');
    }
  });
});
