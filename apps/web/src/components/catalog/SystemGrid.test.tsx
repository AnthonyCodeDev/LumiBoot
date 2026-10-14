import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { systems } from '@lumiboot/catalog';
import { SystemGrid } from './SystemGrid';
import { useCatalogStore } from '../../features/catalog/catalog.store';
import { useFavoritesStore } from '../../features/favorites/favorites.store';

beforeEach(() => {
  useCatalogStore.setState({
    systems,
    family: 'all',
    query: '',
    selectedId: null,
  });
  useFavoritesStore.setState({ ids: new Set<string>() });
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

  it('bascule un favori sur la première carte', async () => {
    const user = userEvent.setup();
    render(<SystemGrid />);
    const firstCard = screen.getAllByRole('article')[0]!;
    await user.click(within(firstCard).getByRole('button', { name: /favoris/i }));
    expect(useFavoritesStore.getState().ids.has('debian-12-i386')).toBe(true);
  });
});
