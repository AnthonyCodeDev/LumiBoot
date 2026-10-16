import { describe, expect, it } from 'vitest';
import type { OSDefinition } from '@lumiboot/contracts';
import { filterSystems, matchesFamily, normalizeText } from './filter';
import { getFeaturedSystem, getSystemById, getSystemBySlug, systems } from './systems';

const debian = getSystemById('debian-12-i386') as OSDefinition;

describe('normalizeText', () => {
  it('supprime les accents et la casse', () => {
    expect(normalizeText('Systèmes ÉTRANGERS')).toBe('systemes etrangers');
  });
});

describe('matchesFamily', () => {
  it('gère all et famille', () => {
    expect(matchesFamily(debian, 'all')).toBe(true);
    expect(matchesFamily(debian, 'linux')).toBe(true);
    expect(matchesFamily(debian, 'windows')).toBe(false);
  });
});

describe('filterSystems', () => {
  const base = { systems, family: 'all', query: '' } as const;

  it('retourne tout le catalogue sans critère', () => {
    expect(filterSystems({ ...base })).toHaveLength(systems.length);
  });

  it('filtre par famille et recherche', () => {
    // 4 entrées plates : Lite (mère), Professionnel (enfant), Windows 10, Windows 11.
    expect(filterSystems({ ...base, family: 'windows' })).toHaveLength(4);
    expect(filterSystems({ ...base, query: 'fedora' })).toHaveLength(1);
    expect(filterSystems({ ...base, query: 'ubuntu x64' })).toHaveLength(0);
  });
});

describe('sélecteurs de catalogue', () => {
  it('renvoie Debian comme système à la une', () => {
    expect(getFeaturedSystem()?.id).toBe('debian-12-i386');
  });

  it('résout par identifiant et par slug', () => {
    expect(getSystemById('debian-12-i386')?.displayName).toBe('Debian');
    expect(getSystemBySlug('macos-sequoia')?.family).toBe('macos');
    expect(getSystemById('inconnu')).toBeNull();
  });
});
