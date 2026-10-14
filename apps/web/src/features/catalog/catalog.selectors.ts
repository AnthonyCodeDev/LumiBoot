import { useMemo } from 'react';
import { filterSystems } from '@lumiboot/catalog';
import type { OSDefinition } from '@lumiboot/contracts';
import { useCatalogStore } from './catalog.store';
import { useFavoritesStore } from '../favorites/favorites.store';

export function useVisibleSystems(): OSDefinition[] {
  const systems = useCatalogStore((state) => state.systems);
  const family = useCatalogStore((state) => state.family);
  const query = useCatalogStore((state) => state.query);
  const favorites = useFavoritesStore((state) => state.ids);

  return useMemo(
    () => filterSystems({ systems, family, query, favoriteIds: favorites }),
    [systems, family, query, favorites],
  );
}

export function useSelectedSystem(): OSDefinition | null {
  const systems = useCatalogStore((state) => state.systems);
  const selectedId = useCatalogStore((state) => state.selectedId);
  return useMemo(
    () => systems.find((system) => system.id === selectedId) ?? null,
    [systems, selectedId],
  );
}
