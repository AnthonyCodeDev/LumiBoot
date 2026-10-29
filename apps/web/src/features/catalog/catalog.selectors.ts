import { useMemo } from 'react';
import { filterSystems, getVariantParent } from '@lumiboot/catalog';
import type { OSDefinition } from '@lumiboot/contracts';
import { useCatalogStore } from './catalog.store';

/** One card per group: filter the flat catalogue (so search matches variants), then fold to parents. */
export function useVisibleSystems(): OSDefinition[] {
  const systems = useCatalogStore((state) => state.systems);
  const family = useCatalogStore((state) => state.family);
  const query = useCatalogStore((state) => state.query);

  return useMemo(() => {
    const filtered = filterSystems({ systems, family, query });
    const seen = new Set<string>();
    const collapsed: OSDefinition[] = [];
    for (const system of filtered) {
      const parent = getVariantParent(system);
      if (seen.has(parent.id)) continue;
      seen.add(parent.id);
      collapsed.push(parent);
    }
    return collapsed;
  }, [systems, family, query]);
}
