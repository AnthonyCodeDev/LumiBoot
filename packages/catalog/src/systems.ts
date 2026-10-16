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
      // `mediaStrategy: 'user-import'` IMPLIQUE un média utilisateur, même si le
      // drapeau explicite est absent : l'état reste honnêtement
      // `resource-required` au lieu d'un `planned` indifférencié.
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
    // Rattachement éventuel au groupe de variantes. Spread conditionnel : on
    // n'introduit jamais de clé `undefined` (rétro-compatibilité des manifestes).
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
  // La une se choisit parmi les systèmes AFFICHÉS (mères + autonomes), jamais
  // parmi les variants enfants.
  const display = getDisplaySystems();
  return display.find((system) => system.featured) ?? display[0] ?? null;
}

/**
 * Id de la mère du groupe de variantes : `variantGroupId` pour un enfant, ou
 * l'id du système lui-même quand il est la mère (ou un système autonome).
 */
export function getVariantParentId(system: Pick<OSDefinition, 'id' | 'variantGroupId'>): string {
  return system.variantGroupId ?? system.id;
}

/**
 * Systèmes AFFICHÉS dans la grille : mères de groupe + systèmes autonomes
 * (ceux qui ne portent PAS de `variantGroupId`). Les variants enfants en sont
 * exclus : ils se choisissent depuis la fiche de leur mère.
 */
export function getDisplaySystems(): OSDefinition[] {
  return systems.filter((system) => system.variantGroupId === undefined);
}

/**
 * Groupe de variantes d'un système : tous les membres (mère + enfants) triés
 * par `variantOrder` croissant (la plus petite valeur = meilleure variante, donc
 * première et sélectionnée par défaut). Les membres sans `variantOrder` viennent
 * après les membres ordonnés ; à égalité, l'ordre du catalogue est conservé
 * (tri stable). Si aucune mère n'est trouvée, renvoie `[system]` (dégradation
 * sûre).
 */
export function getVariantGroup(system: OSDefinition): OSDefinition[] {
  const parentId = getVariantParentId(system);
  const parent = systems.find((candidate) => candidate.id === parentId);
  if (!parent) return [system];

  // Tous les membres du groupe dans l'ordre du catalogue (mère + enfants).
  const members = systems.filter(
    (candidate) => candidate.id === parentId || candidate.variantGroupId === parentId,
  );

  // `Array.prototype.sort` est stable (ES2019) : à `variantOrder` égal, l'ordre
  // du catalogue est préservé. `undefined` passe en dernier (infini).
  return [...members].sort(
    (a, b) =>
      (a.variantOrder ?? Number.POSITIVE_INFINITY) - (b.variantOrder ?? Number.POSITIVE_INFINITY),
  );
}

/**
 * Meilleure variante du groupe d'un système : la première de `getVariantGroup`
 * (celle au plus petit `variantOrder`), soit le système lui-même s'il est
 * autonome.
 */
export function getDefaultVariant(system: OSDefinition): OSDefinition {
  return getVariantGroup(system)[0] ?? system;
}

/**
 * Système « mère » d'un variant (ou le système lui-même s'il est autonome ou
 * déjà la mère).
 */
export function getVariantParent(system: OSDefinition): OSDefinition {
  const parentId = getVariantParentId(system);
  return systems.find((candidate) => candidate.id === parentId) ?? system;
}

/** Vrai si ce système appartient à un groupe de plus d'une entrée. */
export function hasVariants(system: OSDefinition): boolean {
  return getVariantGroup(system).length > 1;
}

/**
 * Origine du média d'un système, telle que DÉCLARÉE par le catalogue. Sert à
 * l'UI pour choisir la vérification runtime adaptée :
 * - `bundled-image` : manifeste d'image publié (`/images/<ref>/manifest.json`)
 *   + disque servi en HTTP Range ;
 * - `local-disk` : manifeste de disque local (`disk-boot`) + disque servi en
 *   HTTP Range (ex. Windows 7, disque gitignoré) ;
 * - `user-import` : média fourni localement par l'utilisateur (jamais distribué,
 *   jamais vérifié par HTTP) — seule sa présence importée compte.
 */
export type DeclaredMediaSource = 'bundled-image' | 'local-disk' | 'user-import';

/**
 * Readiness DÉCLARÉE par le catalogue, volontairement séparée de la
 * disponibilité RUNTIME.
 *
 * `availability` est un état de catalogue : `ready` signifie que l'image est
 * référencée, qu'un profil compatible existe, que le moteur est intégré et que
 * le fonctionnement a été validé. Il ne présume JAMAIS que le média est
 * réellement servable sur la machine : manifeste JSON valide, disque présent,
 * HTTP Range (206), compatibilité architecture/mémoire restent à vérifier au
 * runtime (voir `getLaunchReadiness` / `checkSystemRuntimeAvailability` côté
 * `apps/web`). Confondre les deux produirait un faux `ready` et un bouton de
 * lancement mensonger.
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
