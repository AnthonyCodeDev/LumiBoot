import { z } from 'zod';
import { AssetError } from './errors';
import {
  createSharedRequestRegistry,
  fetchJsonDocument,
  probeRangeAvailability,
  type AssetAvailability,
  type AssetAvailabilityOptions,
} from './manifest-loader';

/** Served form: no `source`/`provenance`, so no operator path leaks. */

const HEX64 = /^[0-9a-f]{64}$/i;
const IMAGE_REF = /^[a-z0-9-]+$/;
// The loopback disk server appends `?token=<bearer>`: that query is allowed, nothing else.
const IMAGE_FILE_URL =
  /^\/images\/[a-z0-9-]+\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\?token=(?:[A-Za-z0-9_.!~*'()-]|%[0-9a-fA-F]{2})+)?$/;
const ENGINE_FILE_URL =
  /^\/v86\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\?token=(?:[A-Za-z0-9_.!~*'()-]|%[0-9a-fA-F]{2})+)?$/;
const ARCHITECTURES = ['i386', 'x86', 'x86_64', 'arm', 'arm64', 'powerpc', 'm68k'] as const;

export const localDiskEngineBinarySchema = z
  .object({
    url: z.string().regex(ENGINE_FILE_URL, 'plain file URL expected under "/v86/"'),
    size: z.number().int().positive(),
    sha256: z.string().regex(HEX64, '64-character hexadecimal SHA-256 expected'),
  })
  .strict();

export const localDiskV86EngineSchema = z
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

/** v64 fetches its own build under `/v64/`; the manifest only selects it. */
export const localDiskV64EngineSchema = z.object({ id: z.literal('v64') }).strict();

export const localDiskEngineSchema = z.discriminatedUnion('id', [
  localDiskV86EngineSchema,
  localDiskV64EngineSchema,
]);

/** A boot asset is a plain file name: no directory, no traversal. */
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `fileName` is the served name, which may differ from the source name. */
export const localDiskFileSchema = z
  .object({
    fileName: z.string().min(1),
    format: z.enum(['raw', 'iso']),
    url: z.string().regex(IMAGE_FILE_URL, 'plain file URL expected under "/images/<ref>/"'),
    size: z.number().int().positive(),
    mtimeMs: z.number().int().nonnegative(),
    sha256: z.string().regex(HEX64, '64-character hexadecimal SHA-256 expected').optional(),
  })
  .strict();

/** OVMF NVRAM image served next to the disk (Windows Boot Manager entry). */
export const localDiskFirmwareVarsSchema = z
  .object({
    fileName: z.string().regex(SAFE_FILE_NAME, 'plain file name expected'),
    url: z.string().regex(IMAGE_FILE_URL, 'plain file URL expected under "/images/<ref>/"'),
    size: z.number().int().positive(),
    mtimeMs: z.number().int().nonnegative(),
    sha256: z.string().regex(HEX64, '64-character hexadecimal SHA-256 expected').optional(),
  })
  .strict();

export const localDiskFirmwareSchema = z
  .object({
    type: z.literal('uefi'),
    vars: localDiskFirmwareVarsSchema,
  })
  .strict();

/**
 * Optional EFI System Partition served next to the system disk.
 *
 * Two-media layouts are purely additive: `disk`/`boot` keep describing the
 * system disk, so the existing `boot.url === disk.url` and
 * `boot.size === disk.size` invariants stay true whether or not an `esp` is
 * declared, and a manifest without `esp` is exactly what it was before.
 * A provider that honours the field mounts the ESP first: `hda` (SATA port 0,
 * the device the OVMF `Boot0001` entry points at) carries the ESP, `hdb`
 * carries the system disk. Only `v64` acts on it; `v86` has no UEFI firmware
 * and keeps mounting `boot` alone.
 *
 * `fileName` is optional and purely local: it is the served name, so a dev
 * server can locate the file next to the manifest without guessing from the
 * URL (the same doctrine as `disk.fileName`). It never reaches the browser.
 */
export const localDiskEspSchema = z
  .object({
    fileName: z.string().regex(SAFE_FILE_NAME, 'plain file name expected').optional(),
    url: z.string().regex(IMAGE_FILE_URL, 'plain file URL expected under "/images/<ref>/"'),
    size: z.number().int().positive(),
  })
  .strict();

/** Exactly one of repository-relative `path` or `external` is expected. */
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

/** v86 probes with `Range: bytes=0-0` then reads blocks; `size` is mandatory. */
export const localDiskBootSchema = z
  .object({
    mode: z.literal('disk-boot'),
    url: z.string().regex(IMAGE_FILE_URL, 'plain file URL expected under "/images/<ref>/"'),
    async: z.literal(true),
    size: z.number().int().positive(),
  })
  .strict();

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
  firmware: localDiskFirmwareSchema.optional(),
  /** Additive two-media layout: never reinterprets `disk`/`boot`. */
  esp: localDiskEspSchema.optional(),
  notes: z.array(z.string().min(1)).optional(),
} as const;

/** `.strict()` rejects `source` and `provenance` from the served form. */
export const localDiskPublicManifestSchema = z
  .object(localDiskCoreShape)
  .strict()
  .superRefine(validateDiskPaths);

/** Public form plus the optional internal `source` and `provenance`. */
export const localDiskManifestSchema = z
  .object({
    ...localDiskCoreShape,
    provenance: z.string().min(1).optional(),
    source: localDiskSourceSchema.optional(),
  })
  .strict()
  .superRefine(validateDiskPaths);

function validateDiskPaths(
  manifest: {
    ref: string;
    disk: { url: string; size: number };
    boot: { url: string; size: number };
    firmware?: { vars: { url: string } } | undefined;
    esp?: { fileName?: string | undefined; url: string; size: number } | undefined;
  },
  context: z.RefinementCtx,
): void {
  if (!manifest.disk.url.startsWith(`/images/${manifest.ref}/`)) {
    context.addIssue({
      code: 'custom',
      path: ['disk', 'url'],
      message: 'disk URL must belong to the manifest reference',
    });
  }
  if (manifest.boot.url !== manifest.disk.url) {
    context.addIssue({
      code: 'custom',
      path: ['boot', 'url'],
      message: 'boot URL must match the disk URL',
    });
  }
  if (manifest.boot.size !== manifest.disk.size) {
    context.addIssue({
      code: 'custom',
      path: ['boot', 'size'],
      message: 'boot size must match the disk size',
    });
  }
  if (
    manifest.firmware !== undefined &&
    !manifest.firmware.vars.url.startsWith(`/images/${manifest.ref}/`)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['firmware', 'vars', 'url'],
      message: 'firmware URL must belong to the manifest reference',
    });
  }
  // The ESP is a second, independent file: `boot` keeps naming the system
  // disk, so the checks above are unchanged and only the ESP's own path is
  // validated here (size and URL presence are the schema's job).
  if (manifest.esp !== undefined && !manifest.esp.url.startsWith(`/images/${manifest.ref}/`)) {
    context.addIssue({
      code: 'custom',
      path: ['esp', 'url'],
      message: 'ESP URL must belong to the manifest reference',
    });
  }
  // The optional local `fileName` names the served file: it must be the last
  // segment of the ESP URL, otherwise a dev server would serve one file while
  // the provider requests another.
  if (
    manifest.esp?.fileName !== undefined &&
    manifest.esp.url.split('?')[0] !== `/images/${manifest.ref}/${manifest.esp.fileName}`
  ) {
    context.addIssue({
      code: 'custom',
      path: ['esp', 'fileName'],
      message: 'ESP file name must match the ESP URL',
    });
  }
}

export type LocalDiskEngineBinary = z.infer<typeof localDiskEngineBinarySchema>;
export type LocalDiskEngine = z.infer<typeof localDiskEngineSchema>;
export type LocalDiskFile = z.infer<typeof localDiskFileSchema>;
export type LocalDiskFirmware = z.infer<typeof localDiskFirmwareSchema>;
export type LocalDiskEsp = z.infer<typeof localDiskEspSchema>;
export type LocalDiskPublicManifest = z.infer<typeof localDiskPublicManifestSchema>;
export type LocalDiskManifest = z.infer<typeof localDiskManifestSchema>;

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'manifest'}: ${issue.message}`)
    .join('; ');
}

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

/** Only form allowed on the network; the result is revalidated. */
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
    ...(manifest.firmware === undefined ? {} : { firmware: manifest.firmware }),
    ...(manifest.esp === undefined ? {} : { esp: manifest.esp }),
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
 * v86's `hda`: always the `boot` device. A manifest that also declares an
 * `esp` still returns the system disk here, because v86 has no UEFI firmware:
 * only `V64Provider` promotes the ESP to `hda` and moves the disk to `hdb`.
 */
export function toV86AsyncDrive(manifest: LocalDiskManifest): V86AsyncDrive {
  return { url: manifest.boot.url, async: true, size: manifest.disk.size };
}

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

const localDiskManifests = new Map<string, LocalDiskManifest>();

/** Deduplicated without depending on the first requester signal. */
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

/** Only the small JSON is fetched here; the disk is read by v86 over HTTP Range. */
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

/** Empty list means conforming; `mtime` is compared only with a `source`. */
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
