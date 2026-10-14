import type { OSDefinition, OSFamily } from '@lumiboot/contracts';

export type FamilyFilter = OSFamily | 'all' | 'favorites';

export interface CatalogFilterCriteria {
  family: FamilyFilter;
  query: string;
  favoriteIds?: Iterable<string>;
  systems: readonly OSDefinition[];
}

/** Recherche accent-insensible et insensible à la casse. */
export function normalizeText(value: string): string {
  return value
    .toLocaleLowerCase('fr')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function matchesFamily(
  os: OSDefinition,
  family: FamilyFilter,
  favoriteIds: ReadonlySet<string>,
): boolean {
  if (family === 'all') return true;
  if (family === 'favorites') return favoriteIds.has(os.id);
  return os.family === family;
}

function haystack(os: OSDefinition): string {
  return normalizeText(
    [
      os.displayName,
      os.versionLabel,
      os.architecture,
      os.family,
      ...os.launchProfiles.flatMap((profile) => [profile.engineId, profile.executionMode]),
    ].join(' '),
  );
}

export function filterSystems(criteria: CatalogFilterCriteria): OSDefinition[] {
  const favorites = new Set(criteria.favoriteIds ?? []);
  const query = normalizeText(criteria.query.trim());

  return criteria.systems.filter((os) => {
    const familyOk = matchesFamily(os, criteria.family, favorites);
    const queryOk = query.length === 0 || haystack(os).includes(query);
    return familyOk && queryOk;
  });
}
