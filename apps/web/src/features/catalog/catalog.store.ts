import { create } from 'zustand';
import { systems as allSystems, type FamilyFilter } from '@lumiboot/catalog';
import type { Architecture, EngineId, OSDefinition } from '@lumiboot/contracts';

/** Adds the value when absent, removes it when present (facet multi-select). */
export function toggleValue<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export interface CatalogState {
  systems: readonly OSDefinition[];
  family: FamilyFilter;
  query: string;
  architectures: Architecture[];
  engines: EngineId[];
  setFamily: (family: FamilyFilter) => void;
  setQuery: (query: string) => void;
  toggleArchitecture: (value: Architecture) => void;
  toggleEngine: (value: EngineId) => void;
  resetFilters: () => void;
}

export const useCatalogStore = create<CatalogState>((set) => ({
  systems: allSystems,
  family: 'all',
  query: '',
  architectures: [],
  engines: [],
  setFamily: (family) => set({ family }),
  setQuery: (query) => set({ query }),
  toggleArchitecture: (value) =>
    set((state) => ({ architectures: toggleValue(state.architectures, value) })),
  toggleEngine: (value) => set((state) => ({ engines: toggleValue(state.engines, value) })),
  resetFilters: () => set({ family: 'all', query: '', architectures: [], engines: [] }),
}));
