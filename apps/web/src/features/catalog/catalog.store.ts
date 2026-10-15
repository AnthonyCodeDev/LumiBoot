import { create } from 'zustand';
import { systems as allSystems, type FamilyFilter } from '@lumiboot/catalog';
import type { OSDefinition } from '@lumiboot/contracts';

export interface CatalogState {
  systems: readonly OSDefinition[];
  family: FamilyFilter;
  query: string;
  setFamily: (family: FamilyFilter) => void;
  setQuery: (query: string) => void;
  resetFilters: () => void;
}

export const useCatalogStore = create<CatalogState>((set) => ({
  systems: allSystems,
  family: 'all',
  query: '',
  setFamily: (family) => set({ family }),
  setQuery: (query) => set({ query }),
  resetFilters: () => set({ family: 'all', query: '' }),
}));
