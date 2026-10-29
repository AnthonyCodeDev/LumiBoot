import { z } from 'zod';
import { vmMediaFormatSchema, type VMMediaFormat } from '@lumiboot/contracts';
import { AssetError } from './errors';
import { sha256Hex } from './hash';

/** User-imported media: the bytes never leave the browser. */

const HEX64 = /^[0-9a-f]{64}$/i;
const IMAGE_REF = /^[a-z0-9-]+$/;

/** Metadata only, never the image itself. */
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

/** `verified` requires a recomputed SHA-256 matching the user manifest. */
export type UserMediaIntegrity = 'verified' | 'unverified';

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
  readonly licenseAcknowledged: boolean;
}

/** Backed by memory, IndexedDB or OPFS. */
export interface UserMediaStore {
  get(ref: string): Promise<UserMediaDescriptor | null>;
  list(): Promise<UserMediaDescriptor[]>;
  put(descriptor: UserMediaDescriptor, bytes: Blob): Promise<void>;
  getBytes(ref: string): Promise<Blob | null>;
  remove(ref: string): Promise<void>;
}

/** Beyond this size, verification is skipped: 256 MiB. */
export const DEFAULT_MAX_HASH_BYTES = 256 * 1024 * 1024;

export interface UserMediaImportOptions {
  /** Without an expected checksum, integrity stays `unverified`. */
  readonly expectedSha256?: string;
  readonly expectedSize?: number;
  readonly maxHashBytes?: number;
  readonly hash?: (bytes: Blob) => Promise<string>;
}

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

/** No license acknowledgement, no import; no reference checksum, no verification. */
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

/** Returns `null` when no reference checksum is expected or the file is too big. */
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

/** In-memory fallback without browser persistence. */
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
