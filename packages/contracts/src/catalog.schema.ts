import { z } from 'zod';

/**
 * Catalogue d'OS — schémas de validation et types inférés.
 *
 * Ces schémas sont la source de vérité partagée entre le catalogue local
 * (`@lumiboot/catalog`) et l'interface Web.
 */

export const osFamilySchema = z.enum(['linux', 'windows', 'macos']);
export const executionModeSchema = z.enum(['browser']);
export const engineIdSchema = z.enum([
  'v86',
  'wasm-x86',
  'wasm-x86_64',
  'wasm-arm',
  'wasm-powerpc',
  'wasm-68k',
]);
export const availabilitySchema = z.enum([
  'planned',
  'experimental',
  'ready',
  'unavailable',
  // Le moteur et le profil sont intégrés, mais le média système (souvent
  // propriétaire) doit être fourni par l'utilisateur : aucune ressource n'est
  // distribuée avec LumiBoot. État honnête tant que le média n'est pas importé.
  'resource-required',
]);
export const architectureSchema = z.enum([
  'i386',
  'x86',
  'x86_64',
  'arm',
  'arm64',
  'powerpc',
  'm68k',
]);

/**
 * Stratégie de fourniture du média système d'une image.
 *
 * - `bundled` : l'image est construite/publiée et servie par LumiBoot ;
 * - `user-import` : aucune image n'est distribuée (licence/propriété) ; le média
 *   est **fourni localement par l'utilisateur** depuis un fichier qu'il détient
 *   légalement (voir docs/windows-7.md). L'état catalogue reste honnête
 *   (`resource-required`) tant que ce média n'a pas été importé.
 */
export const mediaStrategySchema = z.enum(['bundled', 'user-import']);

/** Format de média disque accepté pour un import utilisateur. */
export const vmMediaFormatSchema = z.enum(['raw', 'iso']);

/**
 * Média disque fourni à l'exécution pour un démarrage BIOS (sans noyau Linux).
 * `url` est une URL locale de blob créée par le navigateur, jamais distante.
 */
export const vmMediaSchema = z.object({
  kind: z.literal('disk'),
  url: z.string().min(1),
  size: z.number().int().positive(),
  format: vmMediaFormatSchema,
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/i)
    .optional(),
});

export const vmConfigurationSchema = z.object({
  memoryMiB: z.number().int().positive().optional(),
  vgaMemoryMiB: z.number().int().positive().optional(),
  bootDevice: z.string().min(1).optional(),
  /**
   * Média disque importé (démarrage BIOS) ; absent pour un démarrage par noyau
   * (`bzimage`/`initrd`) adossé à un manifeste d'image publié.
   */
  media: vmMediaSchema.optional(),
  extra: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
});

/** Carte réseau émulée fournie au système invité (`none` = aucune carte). */
export const hardwareNetworkSchema = z.enum(['virtio', 'ne2k', 'none']);

/**
 * Profil matériel émulé, **indépendant du moteur d'exécution**.
 *
 * Il décrit ce que le système invité voit, pas comment un émulateur donné
 * l'implémente : le provider se contente de TRADUIRE ce contrat vers les
 * options de son moteur (v86 `net_device.type`, etc.) sans décider à la place
 * du catalogue.
 *
 * Valeurs par défaut documentées (appliquées par le provider quand un champ est
 * omis), choisies pour rester factuelles vis-à-vis de ce qu'un PC émulé par v86
 * expose réellement :
 * - `network` : `'virtio'` (réseau moderne ; v86 accepte aussi `'ne2k'`/`'none'`) ;
 * - `machine?` : `'pc'` (v86 n'émule qu'un PC à chipset standard) ;
 * - `video?` : `'vga'` (v86 utilise un BIOS VGA) ;
 * - `input?` : `'ps2'` (v86 câble clavier/souris sur un contrôleur PS/2) ;
 * - `disk?` : `'ide'` (v86 expose le disque en ATA/IDE via `hda`) ;
 * - `audio?` : `false` (v86 n'émule pas de carte son dans cette version).
 */
export const hardwareProfileSchema = z.object({
  network: hardwareNetworkSchema,
  machine: z.string().min(1).optional(),
  video: z.enum(['std', 'vga']).optional(),
  input: z.enum(['ps2', 'usb']).optional(),
  disk: z.enum(['ide', 'virtio']).optional(),
  audio: z.boolean().optional(),
  /**
   * Active l'ACPI émulée. Requis par les invités NT modernes (Windows Vista et
   * suivants), documenté par v86 (`docs/windows-nt.md`). Optionnel ; le provider
   * retombe sur `false` si absent.
   */
  acpi: z.boolean().optional(),
});

/** Canal où le système invité prouve son démarrage : série (défaut) ou VGA. */
export const guestReadinessChannelSchema = z.enum(['serial', 'vga']);

/**
 * Mode de preuve de démarrage.
 *
 * - `guest-marker` (défaut) : un marqueur exact émis par le système invité
 *   (unité `lumiboot-ready.service` sur `ttyS0`). Preuve forte : l'OS est
 *   opérationnel.
 * - `disk-boot` : pour un média importé (ex. Windows) qui n'émet AUCUN marqueur
 *   LumiBoot. La preuve est une **lecture réelle du disque dur** après le
 *   démarrage de l'émulateur (le BIOS/l'amorce exécute l'image fournie). C'est
 *   un signal d'exécution invité authentique, mais plus faible qu'un marqueur :
 *   il ne prouve pas que l'OS est pleinement opérationnel. Jamais simulé.
 */
export const guestReadinessModeSchema = z.enum(['guest-marker', 'disk-boot']);

/**
 * Preuve de démarrage attendue du système invité.
 *
 * `marker` est la chaîne exacte écrite par l'invité réellement démarré : elle
 * ne doit jamais être produite côté JavaScript. Valeurs par défaut documentées :
 * `mode` = `'guest-marker'`, `channel` = `'serial'` (ttyS0), `timeoutMs` = 120 000 ms.
 * En mode `disk-boot`, `marker` sert d'identifiant documentaire (jamais scanné).
 *
 * `timeoutMs` est un **seuil de repli**, pas un délai d'échec : le marqueur
 * reste le chemin rapide (transition plus tôt vers `running`) ; s'il n'arrive
 * pas avant l'échéance, la session est tout de même considérée démarrée (repli).
 */
export const guestReadinessSchema = z.object({
  marker: z.string().min(1),
  mode: guestReadinessModeSchema.optional(),
  channel: guestReadinessChannelSchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export const launchProfileSchema = z.object({
  id: z.string().min(1),
  engineId: engineIdSchema,
  executionMode: executionModeSchema,
  minMemoryMiB: z.number().int().positive().optional(),
  featured: z.boolean().optional(),
  configuration: vmConfigurationSchema.optional(),
  /**
   * Matériel émulé de ce profil. Optionnel pour ne pas casser les entrées
   * existantes ; le provider retombe sur `network: 'virtio'` si absent.
   */
  hardwareProfile: hardwareProfileSchema.optional(),
  /**
   * Preuve de démarrage invité de ce profil. Optionnel ; le provider retombe
   * sur `marker: 'LUMIBOOT_GUEST_READY'`, canal `'serial'`, 120 000 ms.
   */
  readiness: guestReadinessSchema.optional(),
});

/**
 * Un `accentRgb` est stocké sous la forme "236,66,100" afin d'alimenter
 * `rgba(var(--accent-rgb), x)` en CSS sans conversion supplémentaire.
 */
export const accentRgbSchema = z
  .string()
  .regex(/^\d{1,3},\d{1,3},\d{1,3}$/, 'Format attendu : « r,g,b » (ex. "236,66,100")');

export const osDefinitionSchema = z.object({
  id: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/, 'slug : minuscules, chiffres et tirets uniquement'),
  family: osFamilySchema,
  displayName: z.string().min(1),
  versionLabel: z.string().min(1),
  architecture: architectureSchema,
  availability: availabilitySchema,
  description: z.string().min(1),
  iconUrl: z.string().min(1),
  minMemoryMiB: z.number().int().positive().optional(),
  imageRef: z.string().min(1).optional(),
  /**
   * Origine du média système. Optionnel : `'bundled'` par défaut. Les systèmes
   * à `'user-import'` ne déclarent AUCUN `imageRef` tant que l'utilisateur n'a
   * pas importé son propre média local.
   */
  mediaStrategy: mediaStrategySchema.optional(),
  launchProfiles: z.array(launchProfileSchema).min(1),
  requirements: z.array(z.string().min(1)).min(1),
  licenseNotes: z.string().min(1).optional(),
  accent: z.string().min(1),
  accentRgb: accentRgbSchema,
  featured: z.boolean().optional(),
  integrationNote: z.string().min(1),
  /**
   * Id du système « mère » de ce variant (absent = ce système EST la mère
   * ou un système autonome).
   */
  variantGroupId: z.string().min(1).optional(),
  /** Libellé court du variant (affiché dans un sélecteur côté fiche). */
  variantName: z.string().min(1).optional(),
  /**
   * Ordre d'affichage de la variante dans son groupe (croissant). La plus
   * petite valeur = meilleure variante = sélection par défaut. Absent = après
   * les variantes ordonnées (ordre du catalogue).
   */
  variantOrder: z.number().int().optional(),
});

export const osCatalogSchema = z.array(osDefinitionSchema).min(1);

export type OSFamily = z.infer<typeof osFamilySchema>;
export type ExecutionMode = z.infer<typeof executionModeSchema>;
export type EngineId = z.infer<typeof engineIdSchema>;
export type Availability = z.infer<typeof availabilitySchema>;
export type Architecture = z.infer<typeof architectureSchema>;
export type MediaStrategy = z.infer<typeof mediaStrategySchema>;
export type VMMedia = z.infer<typeof vmMediaSchema>;
export type VMMediaFormat = z.infer<typeof vmMediaFormatSchema>;
export type VMConfiguration = z.infer<typeof vmConfigurationSchema>;
export type HardwareNetwork = z.infer<typeof hardwareNetworkSchema>;
export type HardwareProfile = z.infer<typeof hardwareProfileSchema>;
export type GuestReadinessChannel = z.infer<typeof guestReadinessChannelSchema>;
export type GuestReadinessMode = z.infer<typeof guestReadinessModeSchema>;
export type GuestReadiness = z.infer<typeof guestReadinessSchema>;
export type LaunchProfile = z.infer<typeof launchProfileSchema>;
export type OSDefinition = z.infer<typeof osDefinitionSchema>;

/**
 * Valeurs par défaut documentées du matériel émulé (voir
 * {@link hardwareProfileSchema}). Utilisées par les providers lorsqu'un profil
 * de lancement omet `hardwareProfile`.
 */
export const DEFAULT_HARDWARE_PROFILE: HardwareProfile = {
  network: 'virtio',
  machine: 'pc',
  video: 'vga',
  input: 'ps2',
  disk: 'ide',
  audio: false,
};

/**
 * Valeurs par défaut documentées de la preuve de démarrage (voir
 * {@link guestReadinessSchema}). Utilisées lorsqu'un profil omet `readiness`.
 * `timeoutMs` est un seuil de repli : au-delà sans marqueur, la session est
 * considérée démarrée, sans erreur.
 */
export const DEFAULT_GUEST_READINESS: GuestReadiness = {
  marker: 'LUMIBOOT_GUEST_READY',
  channel: 'serial',
  timeoutMs: 120_000,
};
