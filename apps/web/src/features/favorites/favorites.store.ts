import { create } from 'zustand';
import { readFavorites, writeFavorites } from './favorites.storage';

export interface FavoritesState {
  ids: ReadonlySet<string>;
  isFavorite: (id: string) => boolean;
  toggle: (id: string) => boolean;
}

export const useFavoritesStore = create<FavoritesState>((set, get) => ({
  ids: readFavorites(),
  isFavorite: (id) => get().ids.has(id),
  toggle: (id) => {
    const next = new Set(get().ids);
    const added = !next.has(id);
    if (added) next.add(id);
    else next.delete(id);
    writeFavorites(next);
    set({ ids: next });
    return added;
  },
}));
