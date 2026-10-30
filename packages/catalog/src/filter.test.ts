import { describe, expect, it } from 'vitest';
import type { OSDefinition } from '@lumiboot/contracts';
import {
  filterSystems,
  matchesArchitecture,
  matchesEngine,
  matchesFamily,
  normalizeText,
} from './filter';
import { getFeaturedSystem, getSystemById, getSystemBySlug, systems } from './systems';

const debian = getSystemById('debian-12-i386') as OSDefinition;
const macos = getSystemById('macos-sequoia') as OSDefinition;

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
    expect(filterSystems({ ...base, family: 'windows' })).toHaveLength(5);
    expect(filterSystems({ ...base, family: 'custom' })).toHaveLength(1);
    // Two flat entries (CLI and XFCE): they fold onto a single Fedora card.
    expect(filterSystems({ ...base, query: 'fedora' })).toHaveLength(2);
    expect(filterSystems({ ...base, query: 'ubuntu x64' })).toHaveLength(0);
  });
});

describe('matchesArchitecture', () => {
  it('treats an empty or absent selection as no constraint', () => {
    expect(matchesArchitecture(debian)).toBe(true);
    expect(matchesArchitecture(debian, [])).toBe(true);
    expect(matchesArchitecture(debian, ['x86_64'])).toBe(false);
  });

  it('accepts any value of the selection (OR inside the facet)', () => {
    expect(matchesArchitecture(debian, ['i386'])).toBe(true);
    expect(matchesArchitecture(debian, ['x86', 'i386'])).toBe(true);
    expect(matchesArchitecture(macos, ['i386', 'x86_64'])).toBe(false);
    expect(matchesArchitecture(macos, ['i386', 'arm64'])).toBe(true);
  });
});

describe('matchesEngine', () => {
  it('treats an empty or absent selection as no constraint', () => {
    expect(matchesEngine(debian)).toBe(true);
    expect(matchesEngine(debian, [])).toBe(true);
    expect(matchesEngine(debian, ['v64'])).toBe(false);
  });

  it('accepts a system exposing several launch profiles', () => {
    const primary = debian.launchProfiles[0]!;
    const multiEngine: OSDefinition = {
      ...debian,
      launchProfiles: [
        { ...primary, engineId: 'v86' },
        { ...primary, id: 'debian-12-i386-v64', engineId: 'v64' },
      ],
    };

    expect(matchesEngine(multiEngine, ['v64'])).toBe(true);
    expect(matchesEngine(multiEngine, ['wasm-arm', 'v86'])).toBe(true);
    expect(matchesEngine(multiEngine, ['wasm-arm'])).toBe(false);
  });
});

// Counts below are the flat catalog (variants included), not the collapsed cards.
describe('filterSystems with the architecture and engine facets', () => {
  const base = { systems, family: 'all', query: '' } as const;

  it('leaves the catalog untouched with empty selections', () => {
    expect(filterSystems({ ...base, architectures: [], engines: [] })).toHaveLength(systems.length);
  });

  it('ORs the values inside each facet', () => {
    const i386 = filterSystems({ ...base, architectures: ['i386'] });
    expect(i386).toHaveLength(11);
    expect(i386.every((os) => os.architecture === 'i386')).toBe(true);

    // Three architectures: 5 x86-64 systems (Fedora CLI/XFCE, Alpine CLI/XFCE,
    // Windows 11) + macOS (arm64).
    expect(filterSystems({ ...base, architectures: ['x86_64', 'arm64'] })).toHaveLength(6);

    const v64 = filterSystems({ ...base, engines: ['v64'] });
    expect(v64.map((os) => os.id)).toEqual([
      'fedora-44-x86-64',
      'fedora-44-x86-64-xfce',
      'alpine-3-24-x86-64',
      'alpine-3-24-x86-64-xfce',
    ]);
    expect(filterSystems({ ...base, engines: ['wasm-x86_64', 'wasm-arm'] })).toHaveLength(2);
  });

  it('ANDs the facets together', () => {
    // `windows` AND `x86_64`: Windows 11 only.
    const windows64 = filterSystems({ ...base, family: 'windows', architectures: ['x86_64'] });
    expect(windows64.map((os) => os.id)).toEqual(['windows-11-x64']);

    // family AND query AND architecture AND engine.
    const linuxDebian = filterSystems({
      ...base,
      family: 'linux',
      query: 'debian',
      architectures: ['i386'],
      engines: ['v86'],
    });
    expect(linuxDebian.map((os) => os.id)).toEqual([
      'debian-12-i386',
      'debian-12-i386-desktop',
      'debian-12-i386-xfce',
    ]);

    // Same query, contradicted by the architecture facet.
    expect(filterSystems({ ...base, query: 'debian', architectures: ['x86_64'] })).toHaveLength(0);
  });

  it('drops the systems without any of the selected engines', () => {
    expect(filterSystems({ ...base, engines: ['wasm-arm'] }).map((os) => os.id)).toEqual([
      'macos-sequoia',
    ]);
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
