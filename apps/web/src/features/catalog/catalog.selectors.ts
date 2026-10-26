import { useMemo } from 'react';
import { filterSystems, getVariantParent } from '@lumiboot/catalog';
import type { OSDefinition } from '@lumiboot/contracts';
import { useCatalogStore } from './catalog.store';

/**
 * Systems shown in the grid: the FLAT catalogue is filtered first (so search also
 * matches child variants), then each result is folded back to its parent with
 * de-duplication. Result: a single card per group.
 */
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
