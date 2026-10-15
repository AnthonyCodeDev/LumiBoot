import { useMemo } from 'react';
import { filterSystems } from '@lumiboot/catalog';
import type { OSDefinition } from '@lumiboot/contracts';
import { useCatalogStore } from './catalog.store';

export function useVisibleSystems(): OSDefinition[] {
  const systems = useCatalogStore((state) => state.systems);
  const family = useCatalogStore((state) => state.family);
  const query = useCatalogStore((state) => state.query);

  return useMemo(() => filterSystems({ systems, family, query }), [systems, family, query]);
}
