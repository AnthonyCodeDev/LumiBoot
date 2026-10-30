import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { systems, type FamilyFilter } from '@lumiboot/catalog';
import type { Architecture, EngineId } from '@lumiboot/contracts';
import {
  buildCatalogFacets,
  useCatalogFacets,
  useVisibleSystems,
  type CatalogFacets,
} from './catalog.selectors';
import { useCatalogStore } from './catalog.store';

const ALL = {
  systems,
  family: 'all' as FamilyFilter,
  query: '',
  architectures: [] as Architecture[],
  engines: [] as EngineId[],
};

function facets(overrides: Partial<typeof ALL> = {}): CatalogFacets {
  return buildCatalogFacets({ ...ALL, ...overrides });
}

function counts(options: CatalogFacets['architectures']): Record<string, number> {
  return Object.fromEntries(options.map((option) => [option.value, option.count]));
}

beforeEach(() => {
  useCatalogStore.setState({
    systems,
    family: 'all',
    query: '',
    architectures: [],
    engines: [],
  });
});

describe('buildCatalogFacets', () => {
  it('counts the displayed cards (parents folded) under All', () => {
    const result = facets();

    // 5 x 32-bit cards, 4 x 64-bit cards, 1 ARM 64-bit card: 10 displayed cards.
    expect(result.architectures.map((option) => option.value)).toEqual(['i386', 'x86_64', 'arm64']);
    expect(counts(result.architectures)).toEqual({ i386: 5, x86_64: 4, arm64: 1 });
    expect(result.architectures.map((option) => option.label)).toEqual([
      '32 bits',
      '64 bits',
      'ARM 64 bits',
    ]);

    // Declared engine order (engines.ts): v86, v64, then the wasm-* engines.
    expect(result.engines.map((option) => option.value)).toEqual([
      'v86',
      'v64',
      'wasm-x86_64',
      'wasm-arm',
    ]);
    expect(counts(result.engines)).toEqual({ v86: 5, v64: 3, 'wasm-x86_64': 1, 'wasm-arm': 1 });
    expect(result.engines[0]?.label).toBe('v86 / WebAssembly');
    expect(result.engines[2]?.label).toBe('WASM x86-64');
  });

  it('excludes the facet from its own counts', () => {
    const result = facets({ architectures: ['x86_64'] });

    // The architecture facet does not constrain itself: the counts stay absolute.
    expect(counts(result.architectures)).toEqual({ i386: 5, x86_64: 4, arm64: 1 });
    // The engine facet is constrained by the architecture: only the 4 x86-64 cards count.
    expect(counts(result.engines)).toEqual({ v86: 0, v64: 3, 'wasm-x86_64': 1, 'wasm-arm': 0 });
  });

  it('keeps the zero-count values listed and disabled', () => {
    const result = facets({ architectures: ['x86_64'] });

    expect(result.engines).toHaveLength(4);
    expect(result.engines.find((option) => option.value === 'v86')?.count).toBe(0);
    expect(result.engines.find((option) => option.value === 'wasm-arm')?.count).toBe(0);
  });

  it('keeps the values offered by the whole library under a narrow family', () => {
    const result = facets({ family: 'macos' });

    expect(result.architectures.map((option) => option.value)).toEqual(['i386', 'x86_64', 'arm64']);
    expect(counts(result.architectures)).toEqual({ i386: 0, x86_64: 0, arm64: 1 });
    expect(counts(result.engines)).toEqual({ v86: 0, v64: 0, 'wasm-x86_64': 0, 'wasm-arm': 1 });
  });

  it('always lists a selected value, even when nothing matches it anymore', () => {
    const result = facets({ family: 'macos', engines: ['v86'] });

    expect(result.engines.map((option) => option.value)).toContain('v86');
    expect(result.engines.find((option) => option.value === 'v86')?.count).toBe(0);
  });

  it('narrows the counts with the search query', () => {
    const result = facets({ query: 'windows' });

    expect(counts(result.architectures)).toEqual({ i386: 2, x86_64: 2, arm64: 0 });
    expect(counts(result.engines)).toEqual({ v86: 2, v64: 1, 'wasm-x86_64': 1, 'wasm-arm': 0 });
  });
});

describe('useVisibleSystems', () => {
  it('applies the architecture and engine facets to the grid', () => {
    const { result } = renderHook(() => useVisibleSystems());
    expect(result.current).toHaveLength(10);

    act(() => {
      useCatalogStore.getState().toggleArchitecture('x86_64');
    });
    expect(result.current.map((system) => system.id)).toEqual([
      'fedora-44-x86-64',
      'alpine-3-24-x86-64',
      'windows-8-1-x64',
      'windows-11-x64',
    ]);

    act(() => {
      useCatalogStore.getState().setFamily('windows');
    });
    expect(result.current.map((system) => system.id)).toEqual([
      'windows-8-1-x64',
      'windows-11-x64',
    ]);

    act(() => {
      useCatalogStore.getState().toggleEngine('wasm-x86_64');
    });
    expect(result.current.map((system) => system.id)).toEqual(['windows-11-x64']);

    act(() => {
      useCatalogStore.getState().resetFilters();
    });
    expect(result.current).toHaveLength(10);
  });
});

describe('useCatalogFacets', () => {
  it('follows the store', () => {
    const { result } = renderHook(() => useCatalogFacets());
    expect(counts(result.current.engines)).toEqual({
      v86: 5,
      v64: 3,
      'wasm-x86_64': 1,
      'wasm-arm': 1,
    });

    act(() => {
      useCatalogStore.getState().toggleArchitecture('arm64');
    });
    expect(counts(result.current.engines)).toEqual({
      v86: 0,
      v64: 0,
      'wasm-x86_64': 0,
      'wasm-arm': 1,
    });
  });
});
