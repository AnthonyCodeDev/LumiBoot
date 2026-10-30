import { beforeEach, describe, expect, it } from 'vitest';
import { systems } from '@lumiboot/catalog';
import { toggleValue, useCatalogStore } from './catalog.store';

beforeEach(() => {
  useCatalogStore.setState({
    systems,
    family: 'all',
    query: '',
    architectures: [],
    engines: [],
  });
});

describe('toggleValue', () => {
  it('adds then removes the value, keeping the selection order', () => {
    expect(toggleValue<string>([], 'a')).toEqual(['a']);
    expect(toggleValue(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleValue(['a', 'b'], 'a')).toEqual(['b']);
    expect(toggleValue(['a', 'b'], 'a')).not.toContain('a');
  });

  it('never mutates the input array', () => {
    const input = ['a'];
    const output = toggleValue(input, 'b');
    expect(input).toEqual(['a']);
    expect(output).not.toBe(input);
  });
});

describe('useCatalogStore', () => {
  it('starts with no facet constraint', () => {
    const state = useCatalogStore.getState();
    expect(state.family).toBe('all');
    expect(state.query).toBe('');
    expect(state.architectures).toEqual([]);
    expect(state.engines).toEqual([]);
  });

  it('toggles an architecture on and off', () => {
    useCatalogStore.getState().toggleArchitecture('x86_64');
    expect(useCatalogStore.getState().architectures).toEqual(['x86_64']);

    useCatalogStore.getState().toggleArchitecture('i386');
    expect(useCatalogStore.getState().architectures).toEqual(['x86_64', 'i386']);

    useCatalogStore.getState().toggleArchitecture('x86_64');
    expect(useCatalogStore.getState().architectures).toEqual(['i386']);
  });

  it('toggles an engine on and off', () => {
    useCatalogStore.getState().toggleEngine('v64');
    useCatalogStore.getState().toggleEngine('wasm-arm');
    expect(useCatalogStore.getState().engines).toEqual(['v64', 'wasm-arm']);

    useCatalogStore.getState().toggleEngine('v64');
    expect(useCatalogStore.getState().engines).toEqual(['wasm-arm']);
  });

  it('keeps the family and the facets independent', () => {
    useCatalogStore.getState().setFamily('windows');
    useCatalogStore.getState().setQuery('8.1');
    useCatalogStore.getState().toggleArchitecture('x86_64');
    useCatalogStore.getState().toggleEngine('v64');

    const state = useCatalogStore.getState();
    expect(state.family).toBe('windows');
    expect(state.query).toBe('8.1');
    expect(state.architectures).toEqual(['x86_64']);
    expect(state.engines).toEqual(['v64']);
  });

  it('resets every filter', () => {
    useCatalogStore.getState().setFamily('windows');
    useCatalogStore.getState().setQuery('windows');
    useCatalogStore.getState().toggleArchitecture('x86_64');
    useCatalogStore.getState().toggleEngine('v64');

    useCatalogStore.getState().resetFilters();

    const state = useCatalogStore.getState();
    expect(state.family).toBe('all');
    expect(state.query).toBe('');
    expect(state.architectures).toEqual([]);
    expect(state.engines).toEqual([]);
    expect(state.systems).toBe(systems);
  });
});
