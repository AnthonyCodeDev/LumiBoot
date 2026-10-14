import { create } from 'zustand';
import { systems as allSystems, type FamilyFilter } from '@lumiboot/catalog';
import type { OSDefinition } from '@lumiboot/contracts';

export interface CatalogState {
  systems: readonly OSDefinition[];
  family: FamilyFilter;
  query: string;
  selectedId: string | null;
  setFamily: (family: FamilyFilter) => void;
  setQuery: (query: string) => void;
  resetFilters: () => void;
  openDetails: (id: string) => void;
  closeDetails: () => void;
}

export const useCatalogStore = create<CatalogState>((set) => ({
  systems: allSystems,
  family: 'all',
  query: '',
  selectedId: null,
  setFamily: (family) => set({ family }),
  setQuery: (query) => set({ query }),
  resetFilters: () => set({ family: 'all', query: '' }),
  openDetails: (id) => set({ selectedId: id }),
  closeDetails: () => set({ selectedId: null }),
}));
