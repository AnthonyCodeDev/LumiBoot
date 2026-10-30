import { useMemo } from 'react';
import {
  engines,
  filterSystems,
  getVariantParent,
  matchesArchitecture,
  matchesEngine,
  type FamilyFilter,
} from '@lumiboot/catalog';
import type { Architecture, EngineId, OSDefinition } from '@lumiboot/contracts';
import { architectureLabels, engineLabels } from '../../lib/labels';
import { useCatalogStore } from './catalog.store';

/** One selectable value of a facet, ready for the UI. */
export interface FacetOption {
  readonly value: string;
  readonly label: string;
  readonly count: number;
}

export interface CatalogFacets {
  readonly architectures: FacetOption[];
  readonly engines: FacetOption[];
}

export interface CatalogFacetCriteria {
  readonly systems: readonly OSDefinition[];
  readonly family: FamilyFilter;
  readonly query: string;
  readonly architectures: readonly Architecture[];
  readonly engines: readonly EngineId[];
}

/** Declared order of the option lists (`architectureLabels`, then `engines.ts`). */
const ARCHITECTURE_ORDER = Object.keys(architectureLabels) as Architecture[];
const ENGINE_ORDER = Object.keys(engines) as EngineId[];

/** One card per group: keep the first variant/parent reached by the filter, folded to its parent. */
function collapseToParents(filtered: readonly OSDefinition[]): OSDefinition[] {
  const seen = new Set<string>();
  const collapsed: OSDefinition[] = [];
  for (const system of filtered) {
    const parent = getVariantParent(system);
    if (seen.has(parent.id)) continue;
    seen.add(parent.id);
    collapsed.push(parent);
  }
  return collapsed;
}

/** One card per group: filter the flat catalogue (so search matches variants), then fold to parents. */
export function useVisibleSystems(): OSDefinition[] {
  const systems = useCatalogStore((state) => state.systems);
  const family = useCatalogStore((state) => state.family);
  const query = useCatalogStore((state) => state.query);
  const architectures = useCatalogStore((state) => state.architectures);
  const engines = useCatalogStore((state) => state.engines);

  return useMemo(() => {
    return collapseToParents(filterSystems({ systems, family, query, architectures, engines }));
  }, [systems, family, query, architectures, engines]);
}

/** Keeps the declared order, and always keeps a selected value even when it is absent. */
function orderedFacetValues<T extends string>(
  order: readonly T[],
  present: ReadonlySet<T>,
  selected: readonly T[],
): T[] {
  const candidates = new Set<T>(present);
  for (const value of selected) candidates.add(value);
  return order.filter((value) => candidates.has(value));
}

/**
 * Classic facet counts: each value counts the displayed cards (parents folded) that match every
 * criterion but this facet. Zero-count values stay listed so the list never jumps around.
 */
export function buildCatalogFacets(criteria: CatalogFacetCriteria): CatalogFacets {
  // Stable list: the values offered by the whole library, whatever the current filters.
  const displayed = collapseToParents(criteria.systems);
  const cards = collapseToParents(
    filterSystems({
      systems: criteria.systems,
      family: criteria.family,
      query: criteria.query,
    }),
  );

  const architectureCounts = new Map<Architecture, number>();
  const engineCounts = new Map<EngineId, number>();

  for (const card of cards) {
    if (matchesEngine(card, criteria.engines)) {
      architectureCounts.set(
        card.architecture,
        (architectureCounts.get(card.architecture) ?? 0) + 1,
      );
    }
    if (matchesArchitecture(card, criteria.architectures)) {
      for (const engineId of new Set(card.launchProfiles.map((profile) => profile.engineId))) {
        engineCounts.set(engineId, (engineCounts.get(engineId) ?? 0) + 1);
      }
    }
  }

  const presentArchitectures = new Set(displayed.map((card) => card.architecture));
  const presentEngines = new Set(
    displayed.flatMap((card) => card.launchProfiles.map((profile) => profile.engineId)),
  );

  return {
    architectures: orderedFacetValues(
      ARCHITECTURE_ORDER,
      presentArchitectures,
      criteria.architectures,
    ).map((architecture) => ({
      value: architecture,
      label: architectureLabels[architecture],
      count: architectureCounts.get(architecture) ?? 0,
    })),
    engines: orderedFacetValues(ENGINE_ORDER, presentEngines, criteria.engines).map((engine) => ({
      value: engine,
      label: engineLabels[engine],
      count: engineCounts.get(engine) ?? 0,
    })),
  };
}

/** Facet options (values, labels and counts) for the current filters. */
export function useCatalogFacets(): CatalogFacets {
  const systems = useCatalogStore((state) => state.systems);
  const family = useCatalogStore((state) => state.family);
  const query = useCatalogStore((state) => state.query);
  const architectures = useCatalogStore((state) => state.architectures);
  const engines = useCatalogStore((state) => state.engines);

  return useMemo(
    () => buildCatalogFacets({ systems, family, query, architectures, engines }),
    [systems, family, query, architectures, engines],
  );
}
