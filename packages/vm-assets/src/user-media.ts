import { z } from 'zod';
import { vmMediaFormatSchema, type VMMediaFormat } from '@lumiboot/contracts';
import { AssetError } from './errors';
import { sha256Hex } from './hash';

/**
 * Média système fourni **localement par l'utilisateur** (import navigateur).
 *
 * LumiBoot ne distribue ni ne télécharge aucun média propriétaire (Windows,
 * macOS). Ce module décrit, valide et conserve uniquement les métadonnées du
 * fichier choisi par l'utilisateur ; les octets restent dans son navigateur
 * (blob en mémoire ou IndexedDB côté `apps/web`). Voir docs/windows-7.md.
 */

const HEX64 = /^[0-9a-f]{64}$/i;
const IMAGE_REF = /^[a-z0-9-]+$/;

/**
 * Manifeste optionnel qu'un utilisateur peut fournir avec son propre média pour
 * permettre une vérification d'intégrité (taille, SHA-256). Il ne contient
 * jamais l'image elle-même — seulement des métadonnées et une provenance.
 */
export const userMediaManifestSchema = z
  .object({
    version: z.literal(1),
    ref: z.string().regex(IMAGE_REF, 'référence : minuscules, chiffres et tirets'),
    displayName: z.string().min(1),
    format: vmMediaFormatSchema,
    architecture: z.enum(['i386', 'x86', 'x86_64', 'arm', 'arm64', 'powerpc', 'm68k']),
    sha256: z.string().regex(HEX64, 'SHA-256 hexadécimal de 64 caractères attendu').optional(),
    sizeBytes: z.number().int().positive().optional(),
    license: z.string().min(1),
    provenance: z.string().min(1),
    notes: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type UserMediaManifest = z.infer<typeof userMediaManifestSchema>;

/** État d'intégrité réellement constaté d'un média importé. */
export type UserMediaIntegrity =
  /** SHA-256 recalculé ET conforme au manifeste fourni par l'utilisateur. */
  | 'verified'
  /** Aucune vérification possible (pas d'empreinte de référence, ou fichier trop gros). */
  | 'unverified';

export interface UserMediaDescriptor {
  readonly ref: string;
  readonly displayName: string;
  readonly fileName: string;
  readonly format: VMMediaFormat;
  readonly size: number;
  readonly integrity: UserMediaIntegrity;
  readonly sha256?: string;
  readonly importedAt: number;
}

export interface UserMediaInput {
  readonly ref: string;
  readonly displayName: string;
  readonly fileName: string;
  readonly format: VMMediaFormat;
  /** L'utilisateur atteste détenir une licence/média légal et autorisé. */
  readonly licenseAcknowledged: boolean;
}

/**
 * Persistance des médias importés. Le contrat ne présume PAS du stockage :
 * mémoire (tests), IndexedDB/OPFS (navigateur, voir `apps/web`).
 */
export interface UserMediaStore {
  get(ref: string): Promise<UserMediaDescriptor | null>;
  list(): Promise<UserMediaDescriptor[]>;
  put(descriptor: UserMediaDescriptor, bytes: Blob): Promise<void>;
  getBytes(ref: string): Promise<Blob | null>;
  remove(ref: string): Promise<void>;
}

/** Taille maximale hachée par défaut (256 Mio) — au-delà, vérification ignorée. */
export const DEFAULT_MAX_HASH_BYTES = 256 * 1024 * 1024;

export interface UserMediaImportOptions {
  /** Empreinte attendue (manifeste utilisateur) : si absente, intégrité `unverified`. */
  readonly expectedSha256?: string;
  /** Taille attendue (manifeste utilisateur) : rejet si différente. */
  readonly expectedSize?: number;
  /** Cap de hachage (défaut 256 Mio) ; au-delà, l'intégrité reste `unverified`. */
  readonly maxHashBytes?: number;
  /** Implémentation de hachage injectable (tests). */
  readonly hash?: (bytes: Blob) => Promise<string>;
}

/**
 * Valide un manifeste utilisateur. Lève un `AssetError` explicite en cas
 * d'incohérence, jamais une erreur anonyme.
 */
export function parseUserMediaManifest(input: unknown): UserMediaManifest {
  const parsed = userMediaManifestSchema.safeParse(input);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'manifeste'} : ${issue.message}`)
      .join(' ; ');
    throw new AssetError('ASSET_INVALID_MANIFEST', `Manifeste utilisateur invalide — ${details}`);
  }
  return parsed.data;
}

/**
 * Importe un média utilisateur : contrôle la licence, la taille et (si fourni)
 * le SHA-256, puis persiste métadonnées + octets dans le store.
 *
 * Règles d'honnêteté :
 * - sans attestation de licence, l'import est refusé ;
 * - une taille ou une empreinte attendue non respectée fait échouer l'import ;
 * - sans empreinte de référence, le média est marqué `unverified` : l'interface
 *   ne doit jamais le présenter comme vérifié.
 */
export async function importUserMedia(
  store: UserMediaStore,
  input: UserMediaInput,
  bytes: Blob,
  options: UserMediaImportOptions = {},
): Promise<UserMediaDescriptor> {
  if (!input.licenseAcknowledged) {
    throw new AssetError(
      'ASSET_IMPORT_REJECTED',
      'Import refusé : la licence et le droit d’usage du média doivent être attestés.',
      { ref: input.ref },
    );
  }

  if (options.expectedSize !== undefined && bytes.size !== options.expectedSize) {
    throw new AssetError(
      'ASSET_SIZE_MISMATCH',
      `Taille inattendue pour « ${input.fileName} » : ${bytes.size} octets au lieu de ${options.expectedSize}.`,
      { ref: input.ref },
    );
  }

  const sha256 = await resolveIntegrity(bytes, options);
  const integrity: UserMediaIntegrity =
    sha256 !== null && options.expectedSha256 !== undefined && sha256 === options.expectedSha256
      ? 'verified'
      : 'unverified';

  const descriptor: UserMediaDescriptor = {
    ref: input.ref,
    displayName: input.displayName,
    fileName: input.fileName,
    format: input.format,
    size: bytes.size,
    integrity,
    ...(sha256 === null ? {} : { sha256 }),
    importedAt: Date.now(),
  };

  await store.put(descriptor, bytes);
  return descriptor;
}

/**
 * Calcule l'empreinte seulement si une référence est attendue et si le fichier
 * reste sous le cap. Sinon retourne `null` (aucune vérification).
 */
async function resolveIntegrity(
  bytes: Blob,
  options: UserMediaImportOptions,
): Promise<string | null> {
  if (options.expectedSha256 === undefined) return null;

  const maxBytes = options.maxHashBytes ?? DEFAULT_MAX_HASH_BYTES;
  if (bytes.size > maxBytes) return null;

  const hash = options.hash ?? defaultHash;
  const computed = await hash(bytes);
  if (!HEX64.test(computed)) {
    throw new AssetError('ASSET_INVALID_MANIFEST', 'Empreinte SHA-256 calculée invalide.');
  }
  if (computed.toLowerCase() !== options.expectedSha256.toLowerCase()) {
    throw new AssetError('ASSET_CHECKSUM_MISMATCH', 'Empreinte SHA-256 non conforme au média.');
  }
  return computed.toLowerCase();
}

async function defaultHash(bytes: Blob): Promise<string> {
  const buffer = await bytes.arrayBuffer();
  return sha256Hex(buffer);
}

/** Store en mémoire (tests, fallback sans persistance navigateur). */
export function createMemoryUserMediaStore(): UserMediaStore {
  const entries = new Map<string, { descriptor: UserMediaDescriptor; bytes: Blob }>();
  return {
    async get(ref) {
      return entries.get(ref)?.descriptor ?? null;
    },
    async list() {
      return [...entries.values()].map((entry) => entry.descriptor);
    },
    async put(descriptor, bytes) {
      entries.set(descriptor.ref, { descriptor, bytes });
    },
    async getBytes(ref) {
      return entries.get(ref)?.bytes ?? null;
    },
    async remove(ref) {
      entries.delete(ref);
    },
  };
}
