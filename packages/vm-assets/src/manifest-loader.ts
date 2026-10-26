import { z } from 'zod';
import { AssetError } from './errors';
import { getImageManifest, registerImageManifest, type ImageManifest } from './manifest';

const HEX64 = /^[0-9a-f]{64}$/i;
const IMAGE_REF = /^[a-z0-9-]+$/;

/**
 * Strict validation of the image manifest served statically.
 *
 * Rejects any absolute URL (unexpected network access), any non-hexadecimal
 * 64-character SHA, any non-positive size and any incomplete manifest: an
 * invalid manifest makes the start fail instead of producing an inconsistent
 * session.
 */
export const imageFileRefSchema = z.object({
  url: z
    .string()
    .min(1)
    .regex(/^\/images\//, 'relative URL expected under "/images/"'),
  sha256: z.string().regex(HEX64, '64-character hexadecimal SHA-256 expected'),
  size: z.number().int().positive(),
  version: z.string().min(1).optional(),
});

export const imageBootOptionsSchema = z
  .object({
    cmdline: z.string().min(1).optional(),
    wasmPath: z.string().min(1).optional(),
    biosUrl: z.string().min(1).optional(),
    vgaBiosUrl: z.string().min(1).optional(),
  })
  .strict();

export const imageManifestSchema = z
  .object({
    ref: z.string().regex(IMAGE_REF, 'reference: lowercase letters, digits and dashes'),
    architecture: z.enum(['i386', 'x86', 'x86_64', 'arm', 'arm64', 'powerpc', 'm68k']),
    memoryMiB: z.number().int().positive(),
    vgaMemoryMiB: z.number().int().positive().optional(),
    license: z.string().min(1),
    files: z
      .object({
        disk: imageFileRefSchema,
        bzimage: imageFileRefSchema,
        initrd: imageFileRefSchema,
      })
      .catchall(imageFileRefSchema),
    boot: imageBootOptionsSchema.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Shared requests (deduplication)
// ---------------------------------------------------------------------------

/**
 * Registry entry: a single request in flight per key, shared by all consumers.
 * Each consumer owns its own abort signal; the underlying request uses an
 * internal signal that is NEVER a consumer's.
 */
interface SharedRequestEntry<V> {
  readonly promise: Promise<V>;
  readonly controller: AbortController;
  /** Number of consumers still interested (ref-count). */
  consumers: number;
}

export interface SharedRequestRegistry<V> {
  /**
   * Joins or starts the shared request associated with `key`.
   *
   * Canceling a consumer only rejects ITS promise: the underlying request
   * continues as long as another consumer awaits it. It is only interrupted when
   * ALL consumers have canceled. A rejection (failure) is never cached: the next
   * request starts a new one.
   */
  run(
    key: string,
    signal: AbortSignal | undefined,
    load: (signal: AbortSignal) => Promise<V>,
  ): Promise<V>;
  /** Number of requests currently in flight (diagnostics / tests). */
  pending(): number;
  /** Interrupts and forgets all in-flight requests (tests). */
  clear(): void;
}

/**
 * Builds a registry of deduplicated requests, isolating per-consumer
 * cancellation (`ref-count`) from the request internal signal.
 *
 * @param createAbortError builds the error returned to a canceled consumer.
 */
export function createSharedRequestRegistry<V>(
  createAbortError: (cause?: unknown) => Error,
): SharedRequestRegistry<V> {
  const entries = new Map<string, SharedRequestEntry<V>>();

  /** Releases a consumer; interrupts the request if nobody is waiting anymore. */
  function release(key: string, entry: SharedRequestEntry<V>): void {
    entry.consumers -= 1;
    if (entry.consumers <= 0 && !entry.controller.signal.aborted) {
      // Request abandoned by ALL: it is interrupted AND removed immediately so a
      // later call starts on a fresh request (a collective cancellation is never
      // a hidden failure).
      entry.controller.abort();
      if (entries.get(key) === entry) entries.delete(key);
    }
  }

  return {
    run(key, signal, load) {
      // An already aborted signal triggers NO request (and does not join an
      // existing request): the consumer is immediately canceled.
      if (signal?.aborted) {
        return Promise.reject(createAbortError());
      }

      let entry = entries.get(key);
      if (entry === undefined) {
        const controller = new AbortController();
        const created: SharedRequestEntry<V> = {
          controller,
          consumers: 0,
          // The internal request NEVER receives a consumer signal: canceling the
          // first requester therefore cannot break the others.
          promise: Promise.resolve().then(() => load(controller.signal)),
        };
        // A failure is never kept: the entry disappears as soon as it settles,
        // whatever the outcome (success or rejection).
        void created.promise
          .finally(() => {
            if (entries.get(key) === created) entries.delete(key);
          })
          .catch(() => undefined);
        entries.set(key, created);
        entry = created;
      }

      const current = entry;
      current.consumers += 1;

      if (signal === undefined) {
        return current.promise.finally(() => release(key, current));
      }

      return new Promise<V>((resolve, reject) => {
        let settled = false;
        // Every exit removes the listener: no `AbortSignal` leaks.
        const onAbort = (): void => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          release(key, current);
          reject(createAbortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        current.promise.then(
          (value) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            release(key, current);
            resolve(value);
          },
          (error: unknown) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            release(key, current);
            reject(error);
          },
        );
      });
    },
    pending: () => entries.size,
    clear() {
      for (const entry of entries.values()) entry.controller.abort();
      entries.clear();
    },
  };
}

/** Shared registry of image manifests. */
const imageManifestRequests = createSharedRequestRegistry<ImageManifest>(
  () => new AssetError('ASSET_ABORTED', 'Manifest load canceled.'),
);

/**
 * Ensures a manifest is registered, then returns it.
 *
 * Never fetches the disk bytes: the manifest is small, the disk is read by v86
 * through HTTP Range. An already registered manifest is not reloaded (reloading
 * a new version is done by clearing the registry via `clearImageManifests()`).
 */
export async function ensureImageManifest(
  ref: string,
  signal?: AbortSignal,
): Promise<ImageManifest> {
  const known = getImageManifest(ref);
  if (known) return known;

  return imageManifestRequests.run(ref, signal, (requestSignal) =>
    loadImageManifest(ref, requestSignal),
  );
}

export async function loadImageManifest(ref: string, signal?: AbortSignal): Promise<ImageManifest> {
  if (!IMAGE_REF.test(ref)) {
    throw new AssetError('ASSET_INVALID_MANIFEST', 'Invalid image reference.', { ref });
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
      throw new AssetError('ASSET_ABORTED', 'Manifest load canceled.', {
        ref,
        cause: error,
      });
    }
    throw new AssetError('ASSET_NOT_FOUND', 'Unreachable manifest.', { ref, cause: error });
  }

  if (!response.ok) {
    throw new AssetError('ASSET_NOT_FOUND', `Manifest HTTP ${response.status}.`, { ref });
  }

  if (readHeader(response, 'content-type').includes('text/html')) {
    throw new AssetError(
      'ASSET_INVALID_MANIFEST',
      'The server returned HTML (SPA fallback) instead of a JSON manifest.',
      { ref },
    );
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    throw new AssetError('ASSET_INVALID_MANIFEST', 'Unreadable JSON manifest.', {
      ref,
      cause: error,
    });
  }

  const parsed = imageManifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new AssetError(
      'ASSET_INVALID_MANIFEST',
      `Invalid manifest — ${formatIssues(parsed.error)}`,
      { ref },
    );
  }

  const manifest = parsed.data as unknown as ImageManifest;
  if (manifest.ref !== ref) {
    throw new AssetError(
      'ASSET_INVALID_MANIFEST',
      'The manifest reference differs from the request.',
      {
        ref,
      },
    );
  }

  registerImageManifest(manifest);
  return manifest;
}

// ---------------------------------------------------------------------------
// Asset availability (manifest + actually servable disk)
// ---------------------------------------------------------------------------

/** Stable unavailability reason, intended for the UI and diagnostics. */
export type AssetUnavailableReason =
  | 'ref-invalid'
  | 'manifest-missing'
  | 'manifest-html'
  | 'manifest-invalid'
  | 'manifest-schema'
  | 'ref-mismatch'
  | 'disk-missing'
  | 'disk-html'
  | 'disk-mismatch'
  | 'range-unsupported'
  | 'unauthorized'
  | 'network'
  | 'aborted';

/** Result of an asset availability check. */
export interface AssetAvailability {
  readonly ref: string;
  readonly available: boolean;
  readonly reason?: AssetUnavailableReason;
  readonly message?: string;
  /** Total size announced by the server (`Content-Range`), if known. */
  readonly size?: number;
}

export interface AssetAvailabilityOptions {
  readonly signal?: AbortSignal;
  /** Injectable `fetch` implementation (tests); `globalThis.fetch` by default. */
  readonly fetchImpl?: typeof fetch;
}

interface RangeProbeOptions extends AssetAvailabilityOptions {
  readonly expectedSize?: number;
}

/** Reads a header whatever the implementation (`Headers` or plain object). */
function readHeader(response: Response, name: string): string {
  const headers = response.headers as unknown;
  if (headers === null || typeof headers !== 'object') return '';
  if (typeof (headers as { get?: unknown }).get === 'function') {
    return String((headers as Headers).get(name) ?? '');
  }
  const record = headers as Record<string, string | undefined>;
  const value = record[name] ?? record[name.toLowerCase()];
  return value === undefined ? '' : String(value);
}

/** Cancels the body of an unread response (avoids downloading a whole disk). */
function discardBody(response: Response): void {
  const body = response.body as ReadableStream<Uint8Array> | null | undefined;
  if (body !== null && body !== undefined && typeof body.cancel === 'function') {
    void body.cancel().catch(() => undefined);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'manifest'}: ${issue.message}`)
    .join('; ');
}

function resolveFetch(options: AssetAvailabilityOptions): typeof fetch {
  const resolved = options.fetchImpl ?? globalThis.fetch;
  if (typeof resolved !== 'function') {
    throw new AssetError('ASSET_NOT_FOUND', 'fetch is unavailable in this environment.');
  }
  return resolved;
}

function unavailable(
  reason: AssetUnavailableReason,
  message: string,
): Omit<AssetAvailability, 'ref'> {
  return { available: false, reason, message };
}

/**
 * Canonical user-facing messages for the "file is not published" cause. They are
 * shown as-is by the UI (`RUNTIME_REASON_MESSAGES` in
 * `apps/web/src/lib/launch.ts`, which reuses them), so their wording — notably
 * the "manifest … missing … 404" word order — is part of the contract and must
 * stay stable.
 */
export const ASSET_UNAVAILABLE_MESSAGES = {
  'manifest-missing': 'The media manifest is missing from the server (HTTP 404).',
  'disk-missing': 'The media disk is missing from the server (HTTP 404).',
} as const satisfies Partial<Record<AssetUnavailableReason, string>>;

type JsonDocumentResult =
  | { readonly kind: 'json'; readonly json: unknown }
  | {
      readonly kind: 'unavailable';
      readonly reason: AssetUnavailableReason;
      readonly message: string;
    };

/**
 * Fetches a JSON document while explicitly distinguishing the failure causes:
 * 404, SPA HTML fallback (instead of JSON), unreadable JSON or network error.
 */
export async function fetchJsonDocument(
  url: string,
  options: AssetAvailabilityOptions = {},
): Promise<JsonDocumentResult> {
  const fetchImpl = resolveFetch(options);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      cache: 'no-cache',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    if (options.signal?.aborted) {
      return { kind: 'unavailable', reason: 'aborted', message: 'Request canceled.' };
    }
    return {
      kind: 'unavailable',
      reason: 'network',
      message: `Unreachable manifest: ${describeError(error)}.`,
    };
  }

  if (response.status === 404) {
    discardBody(response);
    return {
      kind: 'unavailable',
      reason: 'manifest-missing',
      message: ASSET_UNAVAILABLE_MESSAGES['manifest-missing'],
    };
  }
  if (readHeader(response, 'content-type').includes('text/html')) {
    discardBody(response);
    return {
      kind: 'unavailable',
      reason: 'manifest-html',
      message: 'The server returned HTML (SPA fallback) instead of a JSON manifest.',
    };
  }
  if (!response.ok) {
    discardBody(response);
    return {
      kind: 'unavailable',
      reason: 'manifest-missing',
      message: `Manifest HTTP ${response.status}.`,
    };
  }

  try {
    return { kind: 'json', json: await response.json() };
  } catch (error) {
    return {
      kind: 'unavailable',
      reason: 'manifest-invalid',
      message: `Unreadable JSON manifest: ${describeError(error)}.`,
    };
  }
}

/**
 * Checks that a URL is really served over HTTP Range (206 + `Content-Range`), a
 * condition REQUIRED by v86 (`hda.async`). A server that answers 200 to a Range
 * request returns the whole file: the body is immediately canceled and the lack
 * of Range support is reported clearly.
 */
export async function probeRangeAvailability(
  url: string,
  options: RangeProbeOptions = {},
): Promise<Omit<AssetAvailability, 'ref'>> {
  const fetchImpl = resolveFetch(options);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0', 'X-Accept-Encoding': 'identity' },
      cache: 'no-store',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    if (options.signal?.aborted) {
      return unavailable('aborted', 'Disk request canceled.');
    }
    return unavailable('network', `Unreachable disk: ${describeError(error)}.`);
  }

  const contentType = readHeader(response, 'content-type');

  if (response.status === 404) {
    discardBody(response);
    return unavailable('disk-missing', ASSET_UNAVAILABLE_MESSAGES['disk-missing']);
  }

  if (response.status === 200) {
    discardBody(response);
    if (contentType.includes('text/html')) {
      return unavailable(
        'disk-html',
        'The server returned HTML (SPA fallback) instead of the disk.',
      );
    }
    return unavailable(
      'range-unsupported',
      'The server ignores Range (HTTP 200 instead of 206): v86 cannot read the disk by ranges.',
    );
  }

  if (response.status === 206) {
    const contentRange = readHeader(response, 'content-range');
    const match = /\/(\d+)\s*$/.exec(contentRange);
    discardBody(response);
    if (match === null) {
      return unavailable(
        'range-unsupported',
        '206 response without a usable "Content-Range": range reads are undetermined.',
      );
    }
    const size = Number(match[1]);
    if (options.expectedSize !== undefined && size !== options.expectedSize) {
      return {
        available: false,
        reason: 'disk-mismatch',
        message: `Inconsistent disk size: ${size} bytes served, ${options.expectedSize} expected.`,
        size,
      };
    }
    return { available: true, size };
  }

  if (response.status === 401 || response.status === 403) {
    discardBody(response);
    return unavailable('unauthorized', `Disk access denied (HTTP ${response.status}).`);
  }

  discardBody(response);
  return unavailable('network', `Unexpected disk response (HTTP ${response.status}).`);
}

/**
 * Checks that a published image is really usable: JSON manifest valid against
 * the schema, consistent reference, then disk served over HTTP Range (206).
 */
export async function checkImageAvailability(
  ref: string,
  options: AssetAvailabilityOptions = {},
): Promise<AssetAvailability> {
  if (!IMAGE_REF.test(ref)) {
    return { ref, ...unavailable('ref-invalid', 'Invalid image reference.') };
  }

  const document = await fetchJsonDocument(`/images/${ref}/manifest.json`, options);
  if (document.kind === 'unavailable') {
    return { ref, ...unavailable(document.reason, document.message) };
  }

  const parsed = imageManifestSchema.safeParse(document.json);
  if (!parsed.success) {
    return {
      ref,
      ...unavailable('manifest-schema', `Invalid manifest — ${formatIssues(parsed.error)}`),
    };
  }
  if (parsed.data.ref !== ref) {
    return {
      ref,
      ...unavailable('ref-mismatch', 'The manifest reference differs from the request.'),
    };
  }

  const probe = await probeRangeAvailability(parsed.data.files.disk.url, {
    ...options,
    expectedSize: parsed.data.files.disk.size,
  });
  return { ref, ...probe };
}
