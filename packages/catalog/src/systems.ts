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

  // Availability is derived from facts; each candidate is evaluated on its own.
  const availability = getAggregatedAvailability(
    launchProfilesForImage.map((launchProfile) => ({
      hasImage: image.imageRef !== undefined,
      hasCompatibleProfile: launchProfile.executionMode === 'browser',
      engineIntegrated: isEngineIntegrated(launchProfile.engineId),
      validated: launchProfile.validated,
      // User media implies `resource-required`, never a bare `planned`.
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
      // Conditional spread: never introduce an `undefined` key.
      ...(launchProfile.displayMode !== undefined
        ? { displayMode: launchProfile.displayMode }
        : {}),
    })),
    requirements: [...image.requirements],
    accent: family.accent,
    accentRgb: family.accentRgb,
    featured: launchProfilesForImage.some((launchProfile) => launchProfile.featured) || undefined,
    integrationNote: image.integrationNote,
    // Conditional spread: never introduce an `undefined` key.
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
 * Availability is `ready` only when image, profile, engine and validated boot
 * all hold; Zod validates the definitions on load.
 */
export const systems: readonly OSDefinition[] = validateCatalog(definitions);

export function getSystemById(id: string): OSDefinition | null {
  return systems.find((system) => system.id === id) ?? null;
}

export function getSystemBySlug(slug: string): OSDefinition | null {
  return systems.find((system) => system.slug === slug) ?? null;
}

export function getFeaturedSystem(): OSDefinition | null {
  // Featured is chosen among displayed systems, never among child variants.
  const display = getDisplaySystems();
  return display.find((system) => system.featured) ?? display[0] ?? null;
}

/** Parent id: `variantGroupId` for a child, else the system's own id. */
export function getVariantParentId(system: Pick<OSDefinition, 'id' | 'variantGroupId'>): string {
  return system.variantGroupId ?? system.id;
}

/** Displayed systems: parents and standalone ones, child variants excluded. */
export function getDisplaySystems(): OSDefinition[] {
  return systems.filter((system) => system.variantGroupId === undefined);
}

/** Group members sorted by ascending `variantOrder`; ties keep catalog order. */
export function getVariantGroup(system: OSDefinition): OSDefinition[] {
  const parentId = getVariantParentId(system);
  const parent = systems.find((candidate) => candidate.id === parentId);
  if (!parent) return [system];

  // Parent and children, in catalog order.
  const members = systems.filter(
    (candidate) => candidate.id === parentId || candidate.variantGroupId === parentId,
  );

  // Stable sort: equal `variantOrder` keeps catalog order, `undefined` goes last.
  return [...members].sort(
    (a, b) =>
      (a.variantOrder ?? Number.POSITIVE_INFINITY) - (b.variantOrder ?? Number.POSITIVE_INFINITY),
  );
}

/** First of `getVariantGroup`, or the system itself when standalone. */
export function getDefaultVariant(system: OSDefinition): OSDefinition {
  return getVariantGroup(system)[0] ?? system;
}

/** Parent system, or the system itself when standalone or already the parent. */
export function getVariantParent(system: OSDefinition): OSDefinition {
  const parentId = getVariantParentId(system);
  return systems.find((candidate) => candidate.id === parentId) ?? system;
}

/** True when the group has more than one entry. */
export function hasVariants(system: OSDefinition): boolean {
  return getVariantGroup(system).length > 1;
}

/** Media origin declared by the catalog. */
export type DeclaredMediaSource = 'bundled-image' | 'local-disk' | 'user-import';

/** Catalog state: `ready` never means the media is servable at runtime. */
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
