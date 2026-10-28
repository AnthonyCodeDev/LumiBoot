import { describe, expect, it } from 'vitest';
import type { OSDefinition } from '@lumiboot/contracts';
import { filterSystems, matchesFamily, normalizeText } from './filter';
import { getFeaturedSystem, getSystemById, getSystemBySlug, systems } from './systems';

const debian = getSystemById('debian-12-i386') as OSDefinition;

describe('normalizeText', () => {
  it('strips accents and case', () => {
    expect(normalizeText('ÅNGSTRÖM Café')).toBe('angstrom cafe');
  });
});

describe('matchesFamily', () => {
  it('handles all and family', () => {
    expect(matchesFamily(debian, 'all')).toBe(true);
    expect(matchesFamily(debian, 'linux')).toBe(true);
    expect(matchesFamily(debian, 'windows')).toBe(false);
  });
});

describe('filterSystems', () => {
  const base = { systems, family: 'all', query: '' } as const;

  it('returns the whole catalog without criteria', () => {
    expect(filterSystems({ ...base })).toHaveLength(systems.length);
  });

  it('filters by family and search', () => {
    // Five flat entries: Lite, Professional, Windows 8.1 x64, Windows 10 x86, Windows 11.
    // "Custom image" belongs to its own `custom` family, never to Windows.
    expect(filterSystems({ ...base, family: 'windows' })).toHaveLength(5);
    expect(filterSystems({ ...base, family: 'custom' })).toHaveLength(1);
    expect(filterSystems({ ...base, query: 'fedora' })).toHaveLength(1);
    expect(filterSystems({ ...base, query: 'ubuntu x64' })).toHaveLength(0);
  });
});

describe('catalog selectors', () => {
  it('returns Debian as the featured system', () => {
    expect(getFeaturedSystem()?.id).toBe('debian-12-i386');
  });

  it('resolves by identifier and by slug', () => {
    expect(getSystemById('debian-12-i386')?.displayName).toBe('Debian');
    expect(getSystemBySlug('macos-sequoia')?.family).toBe('macos');
    expect(getSystemById('unknown')).toBeNull();
  });
});
