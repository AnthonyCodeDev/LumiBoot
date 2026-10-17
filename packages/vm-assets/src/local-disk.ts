import { z } from 'zod';
import { AssetError } from './errors';
import {
  createSharedRequestRegistry,
  fetchJsonDocument,
  probeRangeAvailability,
  type AssetAvailability,
  type AssetAvailabilityOptions,
} from './manifest-loader';

/**
 * Manifeste d'un disque fourni **localement** (fichier présent sur la machine de
 * l'opérateur, jamais distribué par LumiBoot) démarré par BIOS sous v86.
 *
 * Il diffère du manifeste d'image publiée (`manifest.ts`) : celui-ci exige un
 * noyau (`bzimage`/`initrd`) et des URL sous `/images/`, tandis qu'un disque
 * local n'a ni noyau ni binaire embarqué. Ce module décrit donc uniquement le
 * disque, les binaires du moteur v86 qui l'exécutent, et les paramètres de
 * lecture par HTTP Range (`hda.async`).
 *
 * Deux formes coexistent, volontairement distinctes :
 * - la forme **privée** (fichier du dépôt) peut documenter `source` (chemin réel
 *   de la machine) et `provenance` ;
 * - la forme **publique** (diffusée par HTTP) INTERDIT ces champs internes :
 *   aucun chemin absolu source ne doit jamais sortir du poste de l'opérateur.
 *
 * Rien ici n'est spécifique à Windows : le même format décrit un disque XP,
 * Vista ou tout autre système x86 amorçable fourni par l'utilisateur.
 */

const HEX64 = /^[0-9a-f]{64}$/i;
const IMAGE_REF = /^[a-z0-9-]+$/;
const ARCHITECTURES = ['i386', 'x86', 'x86_64', 'arm', 'arm64', 'powerpc', 'm68k'] as const;

/** Binaire du moteur v86 (WASM ou BIOS) servi statiquement sous `/v86/`. */
export const localDiskEngineBinarySchema = z
  .object({
    url: z
      .string()
      .min(1)
      .regex(/^\/v86\//, 'URL attendue sous « /v86/ »'),
    size: z.number().int().positive(),
    sha256: z.string().regex(HEX64, 'SHA-256 hexadécimal de 64 caractères attendu'),
  })
  .strict();

export const localDiskEngineSchema = z
  .object({
    id: z.literal('v86'),
    wasm: localDiskEngineBinarySchema,
    bios: z
      .object({
        seabios: localDiskEngineBinarySchema,
        vgabios: localDiskEngineBinarySchema,
      })
      .strict(),
  })
  .strict();

/**
 * Disque réellement exposé à v86 par HTTP Range. `url` est une URL relative
 * (jamais absolue) servie par l'hôte local ; `fileName` est le nom **servi**,
 * qui peut différer du nom du fichier source sur disque.
 */
export const localDiskFileSchema = z
  .object({
    fileName: z.string().min(1),
    format: z.enum(['raw', 'iso']),
    url: z
      .string()
      .min(1)
      .regex(/^\/images\//, 'URL attendue sous « /images/ »'),
    size: z.number().int().positive(),
    mtimeMs: z.number().int().nonnegative(),
    sha256: z.string().regex(HEX64, 'SHA-256 hexadécimal de 64 caractères attendu').optional(),
  })
  .strict();

/** Emplacement du fichier source sur la machine locale (jamais distribué). */
export const localDiskSourceSchema = z
  .object({
    path: z.string().min(1),
    size: z.number().int().positive(),
    mtimeMs: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Paramètres passés à v86 pour une lecture asynchrone par plages. `async: true`
 * et `size` sont obligatoires : sans taille, v86 interroge le serveur par
 * `Range: bytes=0-0` puis lit le disque par blocs, sans chargement complet.
 */
export const localDiskBootSchema = z
  .object({
    mode: z.literal('disk-boot'),
    url: z
      .string()
      .min(1)
      .regex(/^\/images\//, 'URL attendue sous « /images/ »'),
    async: z.literal(true),
    size: z.number().int().positive(),
  })
  .strict();

/** Champs communs aux formes publique et privée. */
const localDiskCoreShape = {
  version: z.literal(1),
  ref: z.string().regex(IMAGE_REF, 'référence : minuscules, chiffres et tirets'),
  displayName: z.string().min(1),
  architecture: z.enum(ARCHITECTURES),
  memoryMiB: z.number().int().positive(),
  vgaMemoryMiB: z.number().int().positive().optional(),
  license: z.string().min(1),
  disk: localDiskFileSchema,
  engine: localDiskEngineSchema,
  boot: localDiskBootSchema,
  notes: z.array(z.string().min(1)).optional(),
} as const;

/**
 * Manifeste **public** : exactement ce qui est diffusé par HTTP. `.strict()`
 * rejette toute clé inconnue, donc notamment `source` et `provenance` : un
 * manifeste qui tenterait d'exposer un chemin source est refusé, pas servi.
 */
export const localDiskPublicManifestSchema = z.object(localDiskCoreShape).strict();

/**
 * Manifeste **privé** (fichier du dépôt) : la forme publique, plus `source` et
 * `provenance` optionnels (documentation interne jamais diffusée).
 */
export const localDiskManifestSchema = z
  .object({
    ...localDiskCoreShape,
    provenance: z.string().min(1).optional(),
    source: localDiskSourceSchema.optional(),
  })
  .strict();

export type LocalDiskEngineBinary = z.infer<typeof localDiskEngineBinarySchema>;
export type LocalDiskFile = z.infer<typeof localDiskFileSchema>;
export type LocalDiskPublicManifest = z.infer<typeof localDiskPublicManifestSchema>;
export type LocalDiskManifest = z.infer<typeof localDiskManifestSchema>;

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'manifeste'} : ${issue.message}`)
    .join(' ; ');
}

/**
 * Valide un manifeste disque (forme privée ou publique). Lève un `AssetError`
 * explicite (chemins de champs inclus) : un manifeste incohérent ne doit jamais
 * produire un démarrage partiel silencieux.
 */
export function parseLocalDiskManifest(input: unknown): LocalDiskManifest {
  const parsed = localDiskManifestSchema.safeParse(input);
  if (!parsed.success) {
    throw new AssetError(
      'ASSET_INVALID_MANIFEST',
      `Manifeste disque local invalide — ${formatIssues(parsed.error)}`,
    );
  }
  return parsed.data;
}

/**
 * Valide la forme **publique** uniquement. Utilisé pour garantir qu'un
 * manifeste diffusé par HTTP ne contient aucun champ interne.
 */
export function parseLocalDiskPublicManifest(input: unknown): LocalDiskPublicManifest {
  const parsed = localDiskPublicManifestSchema.safeParse(input);
  if (!parsed.success) {
    throw new AssetError(
      'ASSET_INVALID_MANIFEST',
      `Manifeste disque public invalide — ${formatIssues(parsed.error)}`,
    );
  }
  return parsed.data;
}

/**
 * Sérialise la forme **publique** d'un manifeste disque : retire `source`
 * (chemin réel de la machine) et `provenance` (interne). C'est LA seule forme
 * qui doit être écrite sur le réseau ; le résultat est revalidé pour qu'aucun
 * champ interne ne puisse s'y glisser.
 */
export function toPublicLocalDiskManifest(manifest: LocalDiskManifest): LocalDiskPublicManifest {
  const candidate = {
    version: manifest.version,
    ref: manifest.ref,
    displayName: manifest.displayName,
    architecture: manifest.architecture,
    memoryMiB: manifest.memoryMiB,
    license: manifest.license,
    disk: manifest.disk,
    engine: manifest.engine,
    boot: manifest.boot,
    ...(manifest.vgaMemoryMiB === undefined ? {} : { vgaMemoryMiB: manifest.vgaMemoryMiB }),
    ...(manifest.notes === undefined ? {} : { notes: manifest.notes }),
  };
  const parsed = localDiskPublicManifestSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new AssetError(
      'ASSET_INVALID_MANIFEST',
      `Manifeste disque public invalide — ${formatIssues(parsed.error)}`,
    );
  }
  return parsed.data;
}

/** Paramètres `hda` exacts attendus par v86 pour une lecture par plages. */
export interface V86AsyncDrive {
  readonly url: string;
  readonly async: true;
  readonly size: number;
}

/**
 * Traduit le manifeste en options `hda` v86. Le provider (`@lumiboot/provider-v86`)
 * passe déjà `async: true` et `size` ; cette fonction rend la règle explicite et
 * testable sans dépendre du provider.
 */
export function toV86AsyncDrive(manifest: LocalDiskManifest): V86AsyncDrive {
  return { url: manifest.boot.url, async: true, size: manifest.disk.size };
}

/** Média disque au format attendu par `VMMedia` (`@lumiboot/contracts`). */
export interface LocalDiskMedia {
  readonly kind: 'disk';
  readonly url: string;
  readonly size: number;
  readonly format: 'raw' | 'iso';
  readonly sha256?: string;
}

export function toLocalDiskMedia(manifest: LocalDiskManifest): LocalDiskMedia {
  return {
    kind: 'disk',
    url: manifest.disk.url,
    size: manifest.disk.size,
    format: manifest.disk.format,
    ...(manifest.disk.sha256 === undefined ? {} : { sha256: manifest.disk.sha256 }),
  };
}

/** Manifestes disque local déjà résolus, indexés par référence. */
const localDiskManifests = new Map<string, LocalDiskManifest>();

/** Registre partagé : déduplique sans dépendre du signal du premier demandeur. */
const localDiskRequests = createSharedRequestRegistry<LocalDiskManifest>(
  () => new AssetError('ASSET_ABORTED', 'Chargement du manifeste disque annulé.'),
);

export function getLocalDiskManifest(ref: string): LocalDiskManifest | null {
  return localDiskManifests.get(ref) ?? null;
}

export function registerLocalDiskManifest(manifest: LocalDiskManifest): void {
  localDiskManifests.set(manifest.ref, manifest);
}

export function clearLocalDiskManifests(): void {
  localDiskManifests.clear();
}

/**
 * Garantit qu'un manifeste de disque local est chargé, puis le retourne.
 *
 * Le manifeste est petit (`/images/<ref>/manifest.json`) ; le disque lui-même
 * n'est jamais téléchargé ici : v86 le lira par HTTP Range. Un manifeste déjà
 * enregistré n'est pas rechargé (vider via `clearLocalDiskManifests()`).
 *
 * L'annulation d'un appelant n'interrompt jamais le chargement partagé des
 * autres : voir `createSharedRequestRegistry`.
 */
export async function ensureLocalDiskManifest(
  ref: string,
  signal?: AbortSignal,
): Promise<LocalDiskManifest> {
  const known = getLocalDiskManifest(ref);
  if (known) return known;

  return localDiskRequests.run(ref, signal, (requestSignal) =>
    loadLocalDiskManifest(ref, requestSignal),
  );
}

export async function loadLocalDiskManifest(
  ref: string,
  signal?: AbortSignal,
): Promise<LocalDiskManifest> {
  if (!IMAGE_REF.test(ref)) {
    throw new AssetError('ASSET_INVALID_MANIFEST', 'Référence de disque local invalide.', { ref });
  }

  let response: Response;
  try {
    response = await fetch(`/images/${ref}/manifest.json`, {
      signal: signal ?? null,
      cache: 'no-cache',
      headers: { Accept: 'application/json' },
    });
  } catch (error) {
    if (signal?.aborted) {
      throw new AssetError('ASSET_ABORTED', 'Chargement du manifeste disque annulé.', {
        ref,
        cause: error,
      });
    }
    throw new AssetError('ASSET_NOT_FOUND', 'Manifeste disque inaccessible.', {
      ref,
      cause: error,
    });
  }

  if (!response.ok) {
    throw new AssetError('ASSET_NOT_FOUND', `Manifeste disque HTTP ${response.status}.`, { ref });
  }

  const contentType = response.headers?.get?.('content-type') ?? '';
  if (contentType.includes('text/html')) {
    throw new AssetError(
      'ASSET_INVALID_MANIFEST',
      'Le serveur a renvoyé du HTML (repli SPA) au lieu d’un manifeste disque JSON.',
      { ref },
    );
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    throw new AssetError('ASSET_INVALID_MANIFEST', 'Manifeste disque JSON illisible.', {
      ref,
      cause: error,
    });
  }

  const manifest = parseLocalDiskManifest(json);
  if (manifest.ref !== ref) {
    throw new AssetError(
      'ASSET_INVALID_MANIFEST',
      'La référence du manifeste disque diffère de la demande.',
      { ref },
    );
  }

  registerLocalDiskManifest(manifest);
  return manifest;
}

/**
 * Vérifie qu'un disque local est réellement servable : manifeste JSON valide,
 * référence cohérente, puis disque servi en HTTP Range (206 + `Content-Range`).
 * Toute indisponibilité est motivée (404, repli HTML SPA, absence de Range…).
 */
export async function checkLocalDiskAvailability(
  ref: string,
  options: AssetAvailabilityOptions = {},
): Promise<AssetAvailability> {
  if (!IMAGE_REF.test(ref)) {
    return {
      ref,
      available: false,
      reason: 'ref-invalid',
      message: 'Référence de disque local invalide.',
    };
  }

  const document = await fetchJsonDocument(`/images/${ref}/manifest.json`, options);
  if (document.kind === 'unavailable') {
    return { ref, available: false, reason: document.reason, message: document.message };
  }

  const parsed = localDiskManifestSchema.safeParse(document.json);
  if (!parsed.success) {
    return {
      ref,
      available: false,
      reason: 'manifest-schema',
      message: `Manifeste disque invalide — ${formatIssues(parsed.error)}`,
    };
  }
  if (parsed.data.ref !== ref) {
    return {
      ref,
      available: false,
      reason: 'ref-mismatch',
      message: 'La référence du manifeste disque diffère de la demande.',
    };
  }

  const probe = await probeRangeAvailability(parsed.data.boot.url, {
    ...options,
    expectedSize: parsed.data.disk.size,
  });
  return { ref, ...probe };
}

/**
 * Compare un manifeste aux faits mesurés sur le fichier (taille, mtime,
 * empreinte éventuelle). Retourne la liste des incohérences (vide = conforme) :
 * aucune exception, l'appelant décide du niveau de sévérité.
 *
 * `source` étant optionnel (une forme publique n'en a pas), la comparaison de
 * taille retombe sur la taille du disque et le mtime n'est vérifié que si la
 * source est documentée.
 */
export function diffLocalDiskIntegrity(
  manifest: LocalDiskManifest,
  observed: { size: number; mtimeMs: number; sha256?: string },
): string[] {
  const problems: string[] = [];
  const source = manifest.source;
  const expectedSize = source?.size ?? manifest.disk.size;
  if (observed.size !== expectedSize || observed.size !== manifest.disk.size) {
    problems.push(
      `taille : ${observed.size} (source ${expectedSize}, disque ${manifest.disk.size})`,
    );
  }
  if (source !== undefined && Math.trunc(observed.mtimeMs) !== Math.trunc(source.mtimeMs)) {
    problems.push(
      `mtime source : ${Math.trunc(observed.mtimeMs)} au lieu de ${Math.trunc(source.mtimeMs)}`,
    );
  }
  if (
    manifest.disk.sha256 !== undefined &&
    observed.sha256 !== undefined &&
    observed.sha256.toLowerCase() !== manifest.disk.sha256.toLowerCase()
  ) {
    problems.push(`SHA-256 : ${observed.sha256} au lieu de ${manifest.disk.sha256}`);
  }
  return problems;
}
