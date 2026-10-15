import type { OSDefinition } from '@lumiboot/contracts';
import { validateCatalog } from './validation';
import { families, type OSFamilyDefinition } from './families';
import { images, type SystemImageDefinition } from './images';
import { launchProfiles, type LaunchProfileDefinition } from './profiles';
import { getAggregatedAvailability } from './availability';
import { isEngineIntegrated } from './engines';

const familyIndex = new Map<string, OSFamilyDefinition>(
  families.map((family) => [family.id, family] as const),
);
const launchProfilesByImageId = new Map<string, LaunchProfileDefinition[]>();

for (const profile of launchProfiles) {
  const profilesForImage = launchProfilesByImageId.get(profile.imageId);
  if (profilesForImage) profilesForImage.push(profile);
  else launchProfilesByImageId.set(profile.imageId, [profile]);
}

const definitions: unknown = images.map((image: SystemImageDefinition) => {
  const family = familyIndex.get(image.familyId);
  const launchProfilesForImage = launchProfilesByImageId.get(image.id) ?? [];

  if (!family || launchProfilesForImage.length === 0) {
    throw new Error(`Image ou profil de lancement invalide : ${image.id}`);
  }

  // La disponibilité n'est jamais déclarée par une image ou un profil : elle
  // est DÉRIVÉE des faits (image présente, profil compatible, moteur intégré,
  // fonctionnement validé). Un système ne devient donc pas disponible parce que
  // son image existe.
  //
  // Audit #19 : on évalue chaque candidat (image × profil × moteur) POUR LUI-
  // MÊME. On ne mélange jamais la validation d'un profil avec le moteur d'un
  // autre : un faux `ready` exigerait qu'un MÊME profil coche les quatre
  // conditions.
  const availability = getAggregatedAvailability(
    launchProfilesForImage.map((launchProfile) => ({
      hasImage: image.imageRef !== undefined,
      hasCompatibleProfile: launchProfile.executionMode === 'browser',
      engineIntegrated: isEngineIntegrated(launchProfile.engineId),
      validated: launchProfile.validated,
    })),
  );

  return {
    id: launchProfilesForImage[0]!.id,
    slug: launchProfilesForImage[0]!.slug,
    family: family.family,
    displayName: launchProfilesForImage[0]!.displayName,
    versionLabel: launchProfilesForImage[0]!.versionLabel,
    architecture: image.architecture,
    availability,
    description: launchProfilesForImage[0]!.description,
    iconUrl: family.iconUrl,
    minMemoryMiB: launchProfilesForImage[0]!.minMemoryMiB,
    imageRef: image.imageRef,
    launchProfiles: launchProfilesForImage.map((launchProfile) => ({
      id: launchProfile.id,
      engineId: launchProfile.engineId,
      executionMode: launchProfile.executionMode,
      minMemoryMiB: launchProfile.minMemoryMiB,
      featured: launchProfile.featured ?? undefined,
      configuration: launchProfile.configuration,
      hardwareProfile: launchProfile.hardwareProfile,
      readiness: launchProfile.readiness,
    })),
    requirements: [...image.requirements],
    licenseNotes: image.licenseNotes ?? undefined,
    accent: family.accent,
    accentRgb: family.accentRgb,
    featured: launchProfilesForImage.some((launchProfile) => launchProfile.featured) || undefined,
    integrationNote: image.integrationNote,
  };
});

/**
 * Catalogue LumiBoot — source unique de vérité.
 *
 * RÈGLE UNIQUE DE DISPONIBILITÉ : `availability` est dérivée par
 * `getEffectiveAvailability` et vaut `ready` uniquement si l'image est présente
 * (`imageRef`), qu'un profil compatible existe, que le moteur est intégré et
 * que le fonctionnement est validé. Les images de systèmes propriétaires ne
 * sont jamais incluses ni récupérées automatiquement (voir docs/LICENSES.md).
 *
 * Les définitions sont validées par Zod au chargement : un manifeste invalide
 * fait échouer immédiatement l'application au lieu de produire une UI incohérente.
 */
export const systems: readonly OSDefinition[] = validateCatalog(definitions);

export function getSystemById(id: string): OSDefinition | null {
  return systems.find((system) => system.id === id) ?? null;
}

export function getSystemBySlug(slug: string): OSDefinition | null {
  return systems.find((system) => system.slug === slug) ?? null;
}

export function getFeaturedSystem(): OSDefinition | null {
  return systems.find((system) => system.featured) ?? systems[0] ?? null;
}
