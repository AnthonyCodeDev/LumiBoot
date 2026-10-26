import type { Availability, OSDefinition } from '@lumiboot/contracts';
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
    throw new Error(`Invalid image or launch profile: ${image.id}`);
  }

  // Availability is never declared by an image or a profile: it is DERIVED from
  // facts (image present, compatible profile, integrated engine, validated
  // operation). A system therefore does not become available just because its
  // image exists.
  //
  // Audit #19: each candidate (image × profile × engine) is evaluated ON ITS
  // OWN. The validation of one profile is never mixed with the engine of another
  // one: a false `ready` would require the SAME profile to satisfy all four
  // conditions.
  const availability = getAggregatedAvailability(
    launchProfilesForImage.map((launchProfile) => ({
      hasImage: image.imageRef !== undefined,
      hasCompatibleProfile: launchProfile.executionMode === 'browser',
      engineIntegrated: isEngineIntegrated(launchProfile.engineId),
      validated: launchProfile.validated,
      // `mediaStrategy: 'user-import'` IMPLIES user media, even when the
      // explicit flag is absent: the state honestly stays `resource-required`
      // instead of an undifferentiated `planned`.
      requiresUserMedia: image.requiresUserMedia === true || image.mediaStrategy === 'user-import',
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
    mediaStrategy: image.mediaStrategy ?? 'bundled',
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
    // Optional attachment to the variant group. Conditional spread: an
    // `undefined` key is never introduced (manifest backward compatibility).
    ...(launchProfilesForImage[0]!.variantGroupId !== undefined
      ? { variantGroupId: launchProfilesForImage[0]!.variantGroupId }
      : {}),
    ...(launchProfilesForImage[0]!.variantName !== undefined
      ? { variantName: launchProfilesForImage[0]!.variantName }
      : {}),
    ...(launchProfilesForImage[0]!.variantOrder !== undefined
      ? { variantOrder: launchProfilesForImage[0]!.variantOrder }
      : {}),
  };
});

/**
 * LumiBoot catalog — single source of truth.
 *
 * SINGLE AVAILABILITY RULE: `availability` is derived by
 * `getEffectiveAvailability` and is `ready` only if the image is present
 * (`imageRef`), a compatible profile exists, the engine is integrated and the
 * operation is validated. Images of proprietary systems are never included nor
 * fetched automatically (see docs/LICENSES.md).
 *
 * Definitions are validated by Zod on load: an invalid manifest makes the
 * application fail immediately instead of producing an inconsistent UI.
 */
export const systems: readonly OSDefinition[] = validateCatalog(definitions);

export function getSystemById(id: string): OSDefinition | null {
  return systems.find((system) => system.id === id) ?? null;
}

export function getSystemBySlug(slug: string): OSDefinition | null {
  return systems.find((system) => system.slug === slug) ?? null;
}

export function getFeaturedSystem(): OSDefinition | null {
  // The featured system is chosen among the DISPLAYED systems (parents +
  // standalone), never among child variants.
  const display = getDisplaySystems();
  return display.find((system) => system.featured) ?? display[0] ?? null;
}

/**
 * Id of the parent of the variant group: `variantGroupId` for a child, or the
 * system's own id when it is the parent (or a standalone system).
 */
export function getVariantParentId(system: Pick<OSDefinition, 'id' | 'variantGroupId'>): string {
  return system.variantGroupId ?? system.id;
}

/**
 * Systems DISPLAYED in the grid: group parents + standalone systems (those that
 * do NOT carry a `variantGroupId`). Child variants are excluded: they are
 * chosen from their parent's page.
 */
export function getDisplaySystems(): OSDefinition[] {
  return systems.filter((system) => system.variantGroupId === undefined);
}

/**
 * Variant group of a system: all members (parent + children) sorted by
 * ascending `variantOrder` (the smallest value = best variant, so first and
 * selected by default). Members without `variantOrder` come after the ordered
 * ones; on a tie, catalog order is preserved (stable sort). If no parent is
 * found, returns `[system]` (safe degradation).
 */
export function getVariantGroup(system: OSDefinition): OSDefinition[] {
  const parentId = getVariantParentId(system);
  const parent = systems.find((candidate) => candidate.id === parentId);
  if (!parent) return [system];

  // All group members in catalog order (parent + children).
  const members = systems.filter(
    (candidate) => candidate.id === parentId || candidate.variantGroupId === parentId,
  );

  // `Array.prototype.sort` is stable (ES2019): with equal `variantOrder`,
  // catalog order is preserved. `undefined` goes last (infinity).
  return [...members].sort(
    (a, b) =>
      (a.variantOrder ?? Number.POSITIVE_INFINITY) - (b.variantOrder ?? Number.POSITIVE_INFINITY),
  );
}

/**
 * Best variant of a system's group: the first of `getVariantGroup` (the one
 * with the smallest `variantOrder`), or the system itself if it is standalone.
 */
export function getDefaultVariant(system: OSDefinition): OSDefinition {
  return getVariantGroup(system)[0] ?? system;
}

/**
 * Parent system of a variant (or the system itself if it is standalone or
 * already the parent).
 */
export function getVariantParent(system: OSDefinition): OSDefinition {
  const parentId = getVariantParentId(system);
  return systems.find((candidate) => candidate.id === parentId) ?? system;
}

/** True if this system belongs to a group with more than one entry. */
export function hasVariants(system: OSDefinition): boolean {
  return getVariantGroup(system).length > 1;
}

/**
 * Media origin of a system, as DECLARED by the catalog. Used by the UI to pick
 * the right runtime check:
 * - `bundled-image`: published image manifest (`/images/<ref>/manifest.json`)
 *   + disk served over HTTP Range;
 * - `local-disk`: local disk manifest (`disk-boot`) + disk served over
 *   HTTP Range (e.g. Windows 7, gitignored disk);
 * - `user-import`: media provided locally by the user (never distributed,
 *   never checked over HTTP) — only its imported presence matters.
 */
export type DeclaredMediaSource = 'bundled-image' | 'local-disk' | 'user-import';

/**
 * Readiness DECLARED by the catalog, deliberately separate from RUNTIME
 * availability.
 *
 * `availability` is a catalog state: `ready` means the image is referenced, a
 * compatible profile exists, the engine is integrated and operation has been
 * validated. It NEVER assumes the media is really servable on the machine: a
 * valid JSON manifest, a present disk, HTTP Range (206), architecture/memory
 * compatibility all remain to be checked at runtime (see `getLaunchReadiness` /
 * `checkSystemRuntimeAvailability` in `apps/web`). Confusing the two would
 * produce a false `ready` and a misleading launch button.
 */
export interface DeclaredReadiness {
  readonly availability: Availability;
  readonly mediaSource: DeclaredMediaSource;
}

export function getDeclaredReadiness(
  system: Pick<OSDefinition, 'availability' | 'mediaStrategy' | 'launchProfiles'>,
): DeclaredReadiness {
  const profile =
    system.launchProfiles.find((candidate) => candidate.featured) ?? system.launchProfiles[0];

  let mediaSource: DeclaredMediaSource = 'bundled-image';
  if (system.mediaStrategy === 'user-import') mediaSource = 'user-import';
  else if (profile?.readiness?.mode === 'disk-boot') mediaSource = 'local-disk';

  return { availability: system.availability, mediaSource };
}
