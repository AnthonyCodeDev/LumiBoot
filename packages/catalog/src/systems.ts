import type { OSDefinition } from '@lumiboot/contracts';
import { validateCatalog } from './validation';
import { families, type OSFamilyDefinition } from './families';
import { images, type SystemImageDefinition } from './images';
import { launchProfiles, type LaunchProfileDefinition } from './profiles';

const familyIndex = new Map<string, OSFamilyDefinition>(families.map((family) => [family.id, family] as const));
const imageIndex = new Map<string, SystemImageDefinition>(images.map((image) => [image.id, image] as const));

const definitions: unknown = launchProfiles.map((profile) => {
    const family = familyIndex.get(profile.familyId);
    const image = imageIndex.get(profile.imageId);
    const launchProfile = profile as LaunchProfileDefinition;

    if (!family || !image) {
        throw new Error(`Profil de lancement invalide : ${launchProfile.id}`);
    }

    return {
        id: launchProfile.id,
        slug: launchProfile.slug,
        family: family.family,
        displayName: launchProfile.displayName,
        versionLabel: launchProfile.versionLabel,
        architecture: image.architecture,
        executionMode: image.executionMode,
        engineId: image.engineId,
        availability: launchProfile.availability,
        description: launchProfile.description,
        iconUrl: family.iconUrl,
        minMemoryMiB: image.minMemoryMiB,
        imageRef: image.imageRef,
        requirements: [...image.requirements],
        licenseNotes: image.licenseNotes ?? undefined,
        accent: family.accent,
        accentRgb: family.accentRgb,
        featured: launchProfile.featured ?? undefined,
        integrationNote: image.integrationNote,
    };
});

/**
 * Catalogue LumiBoot — source unique de vérité.
 *
 * RÈGLE : aucune entrée ne passe à `availability: 'ready'` tant que le moteur
 * associé n'a pas réellement démarré le système et exécuté une commande
 * vérifiable. Les images de systèmes propriétaires ne sont jamais incluses ni
 * récupérées automatiquement (voir docs/LICENSES.md).
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
