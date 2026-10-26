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
 * Manifest of a disk provided **locally** (file present on the operator machine,
 * never distributed by LumiBoot) booted by BIOS under v86.
 *
 * It differs from the published image manifest (`manifest.ts`): the latter
 * requires a kernel (`bzimage`/`initrd`) and URLs under `/images/`, while a local
 * disk has neither kernel nor bundled binary. This module therefore only
 * describes the disk, the v86 engine binaries that run it, and the HTTP Range
 * read parameters (`hda.async`).
 *
 * Two forms coexist, deliberately distinct:
 * - the **private** form (repository file) may document `source` (a path
 *   RELATIVE to the repository, or an `external` marker without a path) and
 *   `provenance`;
 * - the **public** form (served over HTTP) FORBIDS those internal fields: no
 *   absolute source path must ever leave the operator machine.
 *
 * Nothing here is Windows-specific: the same format describes an XP, Vista or
 * any other bootable x86 system provided by the user.
 */

const HEX64 = /^[0-9a-f]{64}$/i;
const IMAGE_REF = /^[a-z0-9-]+$/;
const ARCHITECTURES = ['i386', 'x86', 'x86_64', 'arm', 'arm64', 'powerpc', 'm68k'] as const;

/** v86 engine binary (WASM or BIOS) served statically under `/v86/`. */
export const localDiskEngineBinarySchema = z
  .object({
    url: z
      .string()
      .min(1)
      .regex(/^\/v86\//, 'URL expected under "/v86/"'),
    size: z.number().int().positive(),
    sha256: z.string().regex(HEX64, '64-character hexadecimal SHA-256 expected'),
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
 * Disk actually exposed to v86 through HTTP Range. `url` is a relative URL
 * (never absolute) served by the local host; `fileName` is the **served** name,
 * which may differ from the source file name on disk.
 */
export const localDiskFileSchema = z
  .object({
    fileName: z.string().min(1),
    format: z.enum(['raw', 'iso']),
    url: z
      .string()
      .min(1)
      .regex(/^\/images\//, 'URL expected under "/images/"'),
    size: z.number().int().positive(),
    mtimeMs: z.number().int().nonnegative(),
    sha256: z.string().regex(HEX64, '64-character hexadecimal SHA-256 expected').optional(),
  })
  .strict();

/**
 * Location of the source file (never distributed). Two exclusive forms:
 * - `path`: path RELATIVE to the repository root (e.g. `images/<ref>/disk.img`).
 *   A local absolute path has no value on another machine and must never be
 *   published; it stays tolerated for older local manifests.
 * - `external: true`: disk outside the repository, for which NO path is recorded
 *   (size + mtime are enough to re-detect the file).
 */
export const localDiskSourceSchema = z
  .object({
    path: z.string().min(1).optional(),
    external: z.literal(true).optional(),
    size: z.number().int().positive(),
    mtimeMs: z.number().int().nonnegative(),
  })
  .strict()
  .refine((source) => (source.path === undefined) !== (source.external === undefined), {
    message: 'source: exactly one of "path" (repo-relative) or "external" is expected',
  });

/**
 * Parameters passed to v86 for an asynchronous range read. `async: true` and
 * `size` are mandatory: without a size, v86 queries the server with
 * `Range: bytes=0-0` then reads the disk in blocks, without a full load.
 */
export const localDiskBootSchema = z
  .object({
    mode: z.literal('disk-boot'),
    url: z
      .string()
      .min(1)
      .regex(/^\/images\//, 'URL expected under "/images/"'),
    async: z.literal(true),
    size: z.number().int().positive(),
  })
  .strict();

/** Fields shared by the public and private forms. */
const localDiskCoreShape = {
  version: z.literal(1),
  ref: z.string().regex(IMAGE_REF, 'reference: lowercase letters, digits and dashes'),
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
 * **Public** manifest: exactly what is served over HTTP. `.strict()` rejects any
 * unknown key, in particular `source` and `provenance`: a manifest that tried to
 * expose a source path is rejected, not served.
 */
export const localDiskPublicManifestSchema = z.object(localDiskCoreShape).strict();

/**
 * **Private** manifest (repository file): the public form, plus optional
 * `source` and `provenance` (internal documentation never distributed).
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
    .map((issue) => `${issue.path.join('.') || 'manifest'}: ${issue.message}`)
    .join('; ');
}

/**
 * Validates a disk manifest (private or public form). Throws an explicit
 * `AssetError` (including field paths): an inconsistent manifest must never
 * produce a silent partial start.
 */
export function parseLocalDiskManifest(input: unknown): LocalDiskManifest {
  const parsed = localDiskManifestSchema.safeParse(input);
  if (!parsed.success) {
    throw new AssetError(
      'ASSET_INVALID_MANIFEST',
      `Invalid local disk manifest — ${formatIssues(parsed.error)}`,
    );
  }
  return parsed.data;
}

/**
 * Validates the **public** form only. Used to guarantee that a manifest served
 * over HTTP contains no internal field.
 */
export function parseLocalDiskPublicManifest(input: unknown): LocalDiskPublicManifest {
  const parsed = localDiskPublicManifestSchema.safeParse(input);
  if (!parsed.success) {
    throw new AssetError(
      'ASSET_INVALID_MANIFEST',
      `Invalid public disk manifest — ${formatIssues(parsed.error)}`,
    );
  }
  return parsed.data;
}

/**
 * Serializes the **public** form of a disk manifest: removes `source` (real
 * machine path) and `provenance` (internal). It is the ONLY form that must be
 * written on the network; the result is revalidated so no internal field can
 * slip in.
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
      `Invalid public disk manifest — ${formatIssues(parsed.error)}`,
    );
  }
  return parsed.data;
}

/** Exact `hda` parameters expected by v86 for a range read. */
export interface V86AsyncDrive {
  readonly url: string;
  readonly async: true;
  readonly size: number;
}

/**
 * Translates the manifest into v86 `hda` options. The provider
 * (`@lumiboot/provider-v86`) already passes `async: true` and `size`; this
 * function makes the rule explicit and testable without depending on the
 * provider.
 */
export function toV86AsyncDrive(manifest: LocalDiskManifest): V86AsyncDrive {
  return { url: manifest.boot.url, async: true, size: manifest.disk.size };
}

/** Disk media in the format expected by `VMMedia` (`@lumiboot/contracts`). */
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

/** Already resolved local disk manifests, indexed by reference. */
const localDiskManifests = new Map<string, LocalDiskManifest>();

/** Shared registry: deduplicates without depending on the first requester signal. */
const localDiskRequests = createSharedRequestRegistry<LocalDiskManifest>(
  () => new AssetError('ASSET_ABORTED', 'Disk manifest load canceled.'),
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
 * Ensures a local disk manifest is loaded, then returns it.
 *
 * The manifest is small (`/images/<ref>/manifest.json`); the disk itself is
 * never downloaded here: v86 reads it through HTTP Range. An already registered
 * manifest is not reloaded (clear it via `clearLocalDiskManifests()`).
 *
 * Canceling one caller never interrupts the shared load of the others: see
 * `createSharedRequestRegistry`.
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
    throw new AssetError('ASSET_INVALID_MANIFEST', 'Invalid local disk reference.', { ref });
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
      throw new AssetError('ASSET_ABORTED', 'Disk manifest load canceled.', {
        ref,
        cause: error,
      });
    }
    throw new AssetError('ASSET_NOT_FOUND', 'Unreachable disk manifest.', {
      ref,
      cause: error,
    });
  }

  if (!response.ok) {
    throw new AssetError('ASSET_NOT_FOUND', `Disk manifest HTTP ${response.status}.`, { ref });
  }

  const contentType = response.headers?.get?.('content-type') ?? '';
  if (contentType.includes('text/html')) {
    throw new AssetError(
      'ASSET_INVALID_MANIFEST',
      'The server returned HTML (SPA fallback) instead of a JSON disk manifest.',
      { ref },
    );
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    throw new AssetError('ASSET_INVALID_MANIFEST', 'Unreadable JSON disk manifest.', {
      ref,
      cause: error,
    });
  }

  const manifest = parseLocalDiskManifest(json);
  if (manifest.ref !== ref) {
    throw new AssetError(
      'ASSET_INVALID_MANIFEST',
      'The disk manifest reference differs from the request.',
      { ref },
    );
  }

  registerLocalDiskManifest(manifest);
  return manifest;
}

/**
 * Checks that a local disk is really servable: valid JSON manifest, consistent
 * reference, then disk served over HTTP Range (206 + `Content-Range`). Every
 * unavailability is motivated (404, SPA HTML fallback, missing Range…).
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
      message: 'Invalid local disk reference.',
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
      message: `Invalid disk manifest — ${formatIssues(parsed.error)}`,
    };
  }
  if (parsed.data.ref !== ref) {
    return {
      ref,
      available: false,
      reason: 'ref-mismatch',
      message: 'The disk manifest reference differs from the request.',
    };
  }

  const probe = await probeRangeAvailability(parsed.data.boot.url, {
    ...options,
    expectedSize: parsed.data.disk.size,
  });
  return { ref, ...probe };
}

/**
 * Compares a manifest against the facts measured on the file (size, mtime,
 * optional checksum). Returns the list of inconsistencies (empty = conforming):
 * no exception, the caller decides the severity level.
 *
 * `source` being optional (a public form has none), the size comparison falls
 * back to the disk size and mtime is only checked when the source is documented.
 */
export function diffLocalDiskIntegrity(
  manifest: LocalDiskManifest,
  observed: { size: number; mtimeMs: number; sha256?: string },
): string[] {
  const problems: string[] = [];
  const source = manifest.source;
  const expectedSize = source?.size ?? manifest.disk.size;
  if (observed.size !== expectedSize || observed.size !== manifest.disk.size) {
    problems.push(`size: ${observed.size} (source ${expectedSize}, disk ${manifest.disk.size})`);
  }
  if (source !== undefined && Math.trunc(observed.mtimeMs) !== Math.trunc(source.mtimeMs)) {
    problems.push(
      `source mtime: ${Math.trunc(observed.mtimeMs)} instead of ${Math.trunc(source.mtimeMs)}`,
    );
  }
  if (
    manifest.disk.sha256 !== undefined &&
    observed.sha256 !== undefined &&
    observed.sha256.toLowerCase() !== manifest.disk.sha256.toLowerCase()
  ) {
    problems.push(`SHA-256: ${observed.sha256} instead of ${manifest.disk.sha256}`);
  }
  return problems;
}
