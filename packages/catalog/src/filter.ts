import type { Architecture, EngineId, OSDefinition, OSFamily } from '@lumiboot/contracts';

export type FamilyFilter = OSFamily | 'all';

export interface CatalogFilterCriteria {
  family: FamilyFilter;
  query: string;
  systems: readonly OSDefinition[];
  /** Empty/absent = no constraint; OR inside the facet, AND with the other facets. */
  architectures?: readonly Architecture[];
  /** Empty/absent = no constraint; a system matches when one of its profiles uses an engine. */
  engines?: readonly EngineId[];
}

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

/** Architecture facet: the label `32 bits` covers both `i386` and `x86`; empty = no constraint. */
export function matchesArchitecture(
  os: OSDefinition,
  architectures?: readonly Architecture[],
): boolean {
  if (architectures === undefined || architectures.length === 0) return true;
  return architectures.includes(os.architecture);
}

/** A system may expose several launch profiles: any of them is enough. */
export function matchesEngine(os: OSDefinition, engines?: readonly EngineId[]): boolean {
  if (engines === undefined || engines.length === 0) return true;
  return os.launchProfiles.some((profile) => engines.includes(profile.engineId));
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
    // AND between facets, OR inside each facet (handled by the helpers).
    return (
      familyOk &&
      queryOk &&
      matchesArchitecture(os, criteria.architectures) &&
      matchesEngine(os, criteria.engines)
    );
  });
}
