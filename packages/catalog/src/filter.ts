import type { OSDefinition, OSFamily } from '@lumiboot/contracts';

export type FamilyFilter = OSFamily | 'all';

export interface CatalogFilterCriteria {
  family: FamilyFilter;
  query: string;
  systems: readonly OSDefinition[];
}

/** Accent-insensitive and case-insensitive search. */
export function normalizeText(value: string): string {
  return value
    .toLocaleLowerCase('en')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function matchesFamily(os: OSDefinition, family: FamilyFilter): boolean {
  if (family === 'all') return true;
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
  const query = normalizeText(criteria.query.trim());

  return criteria.systems.filter((os) => {
    const familyOk = matchesFamily(os, criteria.family);
    const queryOk = query.length === 0 || haystack(os).includes(query);
    return familyOk && queryOk;
  });
}
