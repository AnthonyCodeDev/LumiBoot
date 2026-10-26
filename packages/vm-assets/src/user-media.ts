import { z } from 'zod';
import { vmMediaFormatSchema, type VMMediaFormat } from '@lumiboot/contracts';
import { AssetError } from './errors';
import { sha256Hex } from './hash';

/**
 * System media provided **locally by the user** (browser import).
 *
 * LumiBoot neither distributes nor downloads any proprietary media (Windows,
 * macOS). This module only describes, validates and keeps the metadata of the
 * file chosen by the user; the bytes stay in their browser (in-memory blob or
 * IndexedDB on the `apps/web` side). See docs/windows-7.md.
 */

const HEX64 = /^[0-9a-f]{64}$/i;
const IMAGE_REF = /^[a-z0-9-]+$/;

/**
 * Optional manifest a user may provide with their own media to allow an
 * integrity check (size, SHA-256). It never contains the image itself — only
 * metadata and a provenance.
 */
export const userMediaManifestSchema = z
  .object({
    version: z.literal(1),
    ref: z.string().regex(IMAGE_REF, 'reference: lowercase letters, digits and dashes'),
    displayName: z.string().min(1),
    format: vmMediaFormatSchema,
    architecture: z.enum(['i386', 'x86', 'x86_64', 'arm', 'arm64', 'powerpc', 'm68k']),
    sha256: z.string().regex(HEX64, '64-character hexadecimal SHA-256 expected').optional(),
    sizeBytes: z.number().int().positive().optional(),
    license: z.string().min(1),
    provenance: z.string().min(1),
    notes: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type UserMediaManifest = z.infer<typeof userMediaManifestSchema>;

/** Integrity state actually observed for an imported media. */
export type UserMediaIntegrity =
  /** SHA-256 recomputed AND matching the manifest provided by the user. */
  | 'verified'
  /** No possible verification (no reference checksum, or file too large). */
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
  /** The user certifies holding a legal and authorized license/media. */
  readonly licenseAcknowledged: boolean;
}

/**
 * Persistence of imported media. The contract does NOT presume the storage:
 * memory (tests), IndexedDB/OPFS (browser, see `apps/web`).
 */
export interface UserMediaStore {
  get(ref: string): Promise<UserMediaDescriptor | null>;
  list(): Promise<UserMediaDescriptor[]>;
  put(descriptor: UserMediaDescriptor, bytes: Blob): Promise<void>;
  getBytes(ref: string): Promise<Blob | null>;
  remove(ref: string): Promise<void>;
}

/** Maximum size hashed by default (256 MiB) — beyond it, verification is skipped. */
export const DEFAULT_MAX_HASH_BYTES = 256 * 1024 * 1024;

export interface UserMediaImportOptions {
  /** Expected checksum (user manifest): if absent, integrity is `unverified`. */
  readonly expectedSha256?: string;
  /** Expected size (user manifest): rejected if different. */
  readonly expectedSize?: number;
  /** Hashing cap (256 MiB default); beyond it, integrity stays `unverified`. */
  readonly maxHashBytes?: number;
  /** Injectable hashing implementation (tests). */
  readonly hash?: (bytes: Blob) => Promise<string>;
}

/**
 * Validates a user manifest. Throws an explicit `AssetError` on inconsistency,
 * never an anonymous error.
 */
export function parseUserMediaManifest(input: unknown): UserMediaManifest {
  const parsed = userMediaManifestSchema.safeParse(input);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'manifest'}: ${issue.message}`)
      .join('; ');
    throw new AssetError('ASSET_INVALID_MANIFEST', `Invalid user manifest — ${details}`);
  }
  return parsed.data;
}

/**
 * Imports a user media: checks the license, the size and (if provided) the
 * SHA-256, then persists metadata + bytes in the store.
 *
 * Honesty rules:
 * - without a license acknowledgement, the import is rejected;
 * - an unexpected size or checksum makes the import fail;
 * - without a reference checksum, the media is marked `unverified`: the
 *   interface must never present it as verified.
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
      'Import rejected: the license and the right to use the media must be acknowledged.',
      { ref: input.ref },
    );
  }

  if (options.expectedSize !== undefined && bytes.size !== options.expectedSize) {
    throw new AssetError(
      'ASSET_SIZE_MISMATCH',
      `Unexpected size for "${input.fileName}": ${bytes.size} bytes instead of ${options.expectedSize}.`,
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
 * Computes the checksum only if a reference is expected and if the file stays
 * under the cap. Otherwise returns `null` (no verification).
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
    throw new AssetError('ASSET_INVALID_MANIFEST', 'Invalid computed SHA-256 checksum.');
  }
  if (computed.toLowerCase() !== options.expectedSha256.toLowerCase()) {
    throw new AssetError('ASSET_CHECKSUM_MISMATCH', 'SHA-256 checksum does not match the media.');
  }
  return computed.toLowerCase();
}

async function defaultHash(bytes: Blob): Promise<string> {
  const buffer = await bytes.arrayBuffer();
  return sha256Hex(buffer);
}

/** In-memory store (tests, fallback without browser persistence). */
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
