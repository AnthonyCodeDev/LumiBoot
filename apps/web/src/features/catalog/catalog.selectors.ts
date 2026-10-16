import { useMemo } from 'react';
import { filterSystems, getVariantParent } from '@lumiboot/catalog';
import type { OSDefinition } from '@lumiboot/contracts';
import { useCatalogStore } from './catalog.store';

/**
 * Systèmes affichés dans la grille : on filtre d'abord le catalogue PLAT (pour
 * que la recherche matche aussi les variantes enfants), puis on replie chaque
 * résultat vers sa mère en dédupliquant. Résultat : une seule carte par groupe.
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
