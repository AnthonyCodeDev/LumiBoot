import { z } from 'zod';
import { AssetError } from './errors';
import { getImageManifest, registerImageManifest, type ImageManifest } from './manifest';
import { versionedMediaUrl } from './media-url';

const HEX64 = /^[0-9a-f]{64}$/i;
const IMAGE_REF = /^[a-z0-9-]+$/;
const IMAGE_FILE_URL = /^\/images\/[a-z0-9-]+\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENGINE_FILE_URL = /^\/v86\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Rejects absolute URLs, non-hex SHAs and incomplete manifests. */
export const imageFileRefSchema = z.object({
  url: z.string().regex(IMAGE_FILE_URL, 'plain file URL expected under "/images/<ref>/"'),
  sha256: z.string().regex(HEX64, '64-character hexadecimal SHA-256 expected'),
  size: z.number().int().positive(),
  version: z.string().min(1).optional(),
});

export const imageBootOptionsSchema = z
  .object({
    cmdline: z.string().min(1).optional(),
    wasmPath: z.string().regex(ENGINE_FILE_URL).optional(),
    biosUrl: z.string().regex(ENGINE_FILE_URL).optional(),
    vgaBiosUrl: z.string().regex(ENGINE_FILE_URL).optional(),
    /** The ISO carries its own bootloader (El-Torito): no kernel injection. */
    cdromOnly: z.boolean().optional(),
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
  .strict()
  .superRefine((manifest, context) => {
    for (const [name, file] of Object.entries(manifest.files)) {
      if (!file.url.startsWith(`/images/${manifest.ref}/`)) {
        context.addIssue({
          code: 'custom',
          path: ['files', name, 'url'],
          message: 'file URL must belong to the manifest reference',
        });
      }
    }
  });

/** One request per key; the request never receives a consumer signal. */
interface SharedRequestEntry<V> {
  readonly promise: Promise<V>;
  readonly controller: AbortController;
  consumers: number;
}

export interface SharedRequestRegistry<V> {
  /** A consumer cancel only rejects its own promise; failures are never cached. */
  run(
    key: string,
    signal: AbortSignal | undefined,
    load: (signal: AbortSignal) => Promise<V>,
  ): Promise<V>;
  pending(): number;
  clear(): void;
}

export function createSharedRequestRegistry<V>(
  createAbortError: (cause?: unknown) => Error,
): SharedRequestRegistry<V> {
  const entries = new Map<string, SharedRequestEntry<V>>();

  /** Aborts the request when no consumer still waits. */
  function release(key: string, entry: SharedRequestEntry<V>): void {
    entry.consumers -= 1;
    if (entry.consumers <= 0 && !entry.controller.signal.aborted) {
      // Removed immediately so a later call starts on a fresh request.
      entry.controller.abort();
      if (entries.get(key) === entry) entries.delete(key);
    }
  }

  return {
    run(key, signal, load) {
      // An already aborted signal starts and joins nothing.
      if (signal?.aborted) {
        return Promise.reject(createAbortError());
      }

      let entry = entries.get(key);
      if (entry === undefined) {
        const controller = new AbortController();
        const created: SharedRequestEntry<V> = {
          controller,
          consumers: 0,
          promise: Promise.resolve().then(() => load(controller.signal)),
        };
        // Never keep a failure: the entry disappears once settled.
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
        // Every exit removes the listener: no `AbortSignal` leak.
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

const imageManifestRequests = createSharedRequestRegistry<ImageManifest>(
  () => new AssetError('ASSET_ABORTED', 'Manifest load canceled.'),
);

/** The JSON is fetched once; v86 reads the disk itself over HTTP Range. */
export async function ensureImageManifest(
  ref: string,
  signal?: AbortSignal,
  options: ImageManifestLoadOptions = {},
): Promise<ImageManifest> {
  const known = getImageManifest(ref);
  if (known) return known;

  return imageManifestRequests.run(ref, signal, (requestSignal) =>
    loadImageManifest(ref, requestSignal, options),
  );
}

export async function loadImageManifest(
  ref: string,
  signal?: AbortSignal,
  options: ImageManifestLoadOptions = {},
): Promise<ImageManifest> {
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

  await assertDiskServedByRanges(manifest, signal, options);

  registerImageManifest(manifest);
  return manifest;
}

/** Stable reason, intended for the UI and diagnostics. */
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
  | 'range-intercepted'
  | 'unauthorized'
  | 'network'
  | 'aborted';

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
  /** Injectable `fetch` (tests); `globalThis.fetch` by default. */
  readonly fetchImpl?: typeof fetch;
}

interface RangeProbeOptions extends AssetAvailabilityOptions {
  readonly expectedSize?: number;
}

/** Tolerates `Headers` and plain-object test doubles. */
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

/** Cancels an unread body so the whole disk is not downloaded. */
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

/** The wording is part of the UI contract and must stay stable. */
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

/** v86 needs HTTP Range; a 200 answer's body is canceled at once. */
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

/** Minimal XHR surface: v86 reads disks with XHR, so the probe must too. */
export interface RangeRequest {
  timeout: number;
  responseType: XMLHttpRequestResponseType;
  readonly status: number;
  readonly response: ArrayBuffer | null;
  getResponseHeader(name: string): string | null;
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(): void;
  abort(): void;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  ontimeout: (() => void) | null;
  onabort: (() => void) | null;
}

/** Injectable for tests; `XMLHttpRequest` by default. */
export type RangeRequestFactory = () => RangeRequest;

export interface RangeReadProbeOptions {
  readonly signal?: AbortSignal;
  /** Short by design: a 4 KiB read must answer at once. */
  readonly timeoutMs?: number;
  readonly createRequest?: RangeRequestFactory;
}

/** A skipped probe means the environment cannot issue the request at all. */
export type RangeReadProbeOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: AssetUnavailableReason;
      readonly message: string;
      readonly cause?: unknown;
    };

export interface ImageManifestLoadOptions {
  /** Injectable v86-style range read (tests); `probeRangeRead` by default. */
  readonly rangeProbe?: (
    url: string,
    size: number,
    options?: RangeReadProbeOptions,
  ) => Promise<RangeReadProbeOutcome>;
  readonly rangeProbeOptions?: RangeReadProbeOptions;
  /** Byte cross-check transport; `null` disables it (tests). */
  readonly controlFetch?: typeof fetch | null;
}

export const RANGE_READ_PROBE_TIMEOUT_MS = 15_000;

/** Non-zero offset: a whole-file (HTTP 200) answer from a cache is unmistakable. */
const RANGE_READ_PROBE_OFFSET = 4096;
const RANGE_READ_PROBE_LENGTH = 4096;

type RangeAttempt =
  | {
      readonly kind: 'response';
      readonly status: number;
      readonly byteLength: number;
      readonly contentRange: string;
      readonly bytes: Uint8Array | null;
    }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'error'; readonly cause?: unknown }
  | { readonly kind: 'aborted' };

function defaultRangeRequestFactory(): RangeRequestFactory | undefined {
  const constructor = (globalThis as { XMLHttpRequest?: new () => RangeRequest }).XMLHttpRequest;
  if (typeof constructor !== 'function') return undefined;
  return () => new constructor();
}

/** Resolves once, whatever the callback order or abort signal. */
function sendRangeRequest(
  request: RangeRequest,
  url: string,
  offset: number,
  length: number,
  options: RangeReadProbeOptions,
): Promise<RangeAttempt> {
  return new Promise<RangeAttempt>((resolve) => {
    const signal = options.signal;
    let settled = false;

    const finish = (attempt: RangeAttempt): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(attempt);
    };

    function onAbort(): void {
      try {
        request.abort();
      } catch {
        /* already finished */
      }
      finish({ kind: 'aborted' });
    }

    request.onload = () => {
      let contentRange = '';
      try {
        contentRange = request.getResponseHeader('Content-Range') ?? '';
      } catch {
        /* header unreadable: treated as absent */
      }
      const body = request.response;
      finish({
        kind: 'response',
        status: request.status,
        byteLength:
          body !== null && typeof (body as { byteLength?: unknown }).byteLength === 'number'
            ? body.byteLength
            : -1,
        contentRange,
        // Only an `ArrayBuffer` body is comparable.
        bytes: body instanceof ArrayBuffer ? new Uint8Array(body) : null,
      });
    };
    request.onerror = () => finish({ kind: 'error' });
    request.ontimeout = () => finish({ kind: 'timeout' });
    request.onabort = () => finish({ kind: 'aborted' });
    request.timeout = options.timeoutMs ?? RANGE_READ_PROBE_TIMEOUT_MS;

    if (signal?.aborted) {
      finish({ kind: 'aborted' });
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      request.open('GET', url);
      // v86 compares an `ArrayBuffer` body, and decompression must not alter the range.
      request.responseType = 'arraybuffer';
      // Same headers as v86, and no cache directive: the probe must follow the
      // browser's real disk path.
      request.setRequestHeader('Range', `bytes=${offset}-${offset + length - 1}`);
      request.setRequestHeader('X-Accept-Encoding', 'identity');
      request.send();
    } catch {
      // A synchronous throw means the request never left the browser: not a boot blocker.
      finish({ kind: 'unavailable' });
    }
  });
}

/** Outcome plus the bytes actually read, for the cross-check. */
interface RangeProbeRead {
  readonly outcome: RangeReadProbeOutcome;
  readonly bytes: Uint8Array | null;
  readonly status: number | null;
  readonly offset: number;
  readonly length: number;
}

/** A 200 answer leaves v86's read unresolved and the guest reads zeros forever. */
export async function probeRangeRead(
  url: string,
  size: number,
  options: RangeReadProbeOptions = {},
): Promise<RangeReadProbeOutcome> {
  return (await readRangeProbe(url, size, options)).outcome;
}

async function readRangeProbe(
  url: string,
  size: number,
  options: RangeReadProbeOptions = {},
): Promise<RangeProbeRead> {
  const skipped = (outcome: RangeReadProbeOutcome = { ok: true }): RangeProbeRead => ({
    outcome,
    bytes: null,
    status: null,
    offset: 0,
    length: 0,
  });

  const createRequest = options.createRequest ?? defaultRangeRequestFactory();
  // No `XMLHttpRequest` (Node, workers): the probe cannot mirror v86, so it is a no-op.
  if (createRequest === undefined) return skipped();

  const offset = size > RANGE_READ_PROBE_OFFSET ? RANGE_READ_PROBE_OFFSET : 0;
  const length = Math.min(RANGE_READ_PROBE_LENGTH, size - offset);
  if (length <= 0) return skipped();

  let request: RangeRequest;
  try {
    request = createRequest();
  } catch {
    // Nothing to compare against.
    return skipped();
  }

  const attempt = await sendRangeRequest(request, url, offset, length, options);
  const read = (
    outcome: RangeReadProbeOutcome,
    bytes: Uint8Array | null,
    status: number | null,
  ): RangeProbeRead => ({
    outcome,
    bytes,
    status,
    offset,
    length,
  });

  switch (attempt.kind) {
    case 'aborted':
      return read(
        options.signal?.aborted === true
          ? {
              ok: false,
              reason: 'aborted',
              message: 'Disk range probe canceled.',
            }
          : { ok: true },
        null,
        null,
      );
    case 'timeout':
      return read(
        {
          ok: false,
          reason: 'network',
          message: `The disk did not answer a ${length}-byte range read within ${
            (options.timeoutMs ?? RANGE_READ_PROBE_TIMEOUT_MS) / 1000
          } s.`,
        },
        null,
        null,
      );
    case 'unavailable':
      return skipped();
    case 'error':
      return read(
        {
          ok: false,
          reason: 'network',
          message: 'The disk does not answer a range read the way v86 issues it.',
          ...(attempt.cause === undefined ? {} : { cause: attempt.cause }),
        },
        null,
        null,
      );
    case 'response':
      break;
  }

  if (attempt.status === 200) {
    return read(
      {
        ok: false,
        reason: 'range-intercepted',
        message:
          `${url} was not served as ranged content (HTTP 200 instead of 206): a cached ` +
          'response, a service worker or a proxy is intercepting the disk. Clear this ' +
          "site's data (DevTools > Application > Clear site data), unregister any service " +
          'worker for this origin, then reload.',
      },
      attempt.bytes,
      attempt.status,
    );
  }

  if (attempt.status === 404) {
    return read(
      {
        ok: false,
        reason: 'disk-missing',
        message: ASSET_UNAVAILABLE_MESSAGES['disk-missing'],
      },
      attempt.bytes,
      attempt.status,
    );
  }

  if (attempt.status === 401 || attempt.status === 403) {
    return read(
      {
        ok: false,
        reason: 'unauthorized',
        message: `Disk access denied (HTTP ${attempt.status}).`,
      },
      attempt.bytes,
      attempt.status,
    );
  }

  if (attempt.status !== 206) {
    return read(
      {
        ok: false,
        reason: 'range-unsupported',
        message: `Unexpected disk range response (HTTP ${attempt.status} instead of 206).`,
      },
      attempt.bytes,
      attempt.status,
    );
  }

  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(attempt.contentRange.trim());
  if (match === null) {
    return read(
      {
        ok: false,
        reason: 'range-unsupported',
        message: `HTTP 206 without a usable "Content-Range" (${attempt.contentRange || 'missing'}): range reads are undetermined.`,
      },
      attempt.bytes,
      attempt.status,
    );
  }
  const [start, end] = [Number(match[1]), Number(match[2])];
  if (start !== offset || end !== offset + length - 1) {
    return read(
      {
        ok: false,
        reason: 'range-unsupported',
        message: `"Content-Range" ${attempt.contentRange} does not match the requested bytes ${offset}-${offset + length - 1}.`,
      },
      attempt.bytes,
      attempt.status,
    );
  }
  if (match[3] !== '*' && Number(match[3]) !== size) {
    return read(
      {
        ok: false,
        reason: 'disk-mismatch',
        message: `Inconsistent disk size: ${Number(match[3])} bytes served, ${size} expected.`,
      },
      attempt.bytes,
      attempt.status,
    );
  }
  if (attempt.byteLength !== length) {
    return read(
      {
        ok: false,
        reason: 'disk-mismatch',
        message: `The range read returned ${attempt.byteLength} bytes instead of ${length}.`,
      },
      attempt.bytes,
      attempt.status,
    );
  }

  return read({ ok: true }, attempt.bytes, attempt.status);
}

interface HeaderBagLike {
  get(name: string): string | null;
}

/** A stub `fetch` (tests) has no body: nothing to compare with. */
function canCompareBytes(response: Response): boolean {
  const headers = (response as { headers?: unknown }).headers;
  return (
    typeof (response as { arrayBuffer?: unknown }).arrayBuffer === 'function' &&
    headers !== null &&
    headers !== undefined &&
    typeof (headers as HeaderBagLike).get === 'function'
  );
}

function isAllZero(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte !== 0) return false;
  }
  return true;
}

/** `null` means the two ranged bodies agree. */
export type RangeByteDivergence = 'length' | 'all-zero' | 'content';

export function detectRangeByteDivergence(
  browserBytes: Uint8Array,
  controlBytes: Uint8Array,
): RangeByteDivergence | null {
  if (browserBytes.length !== controlBytes.length) return 'length';
  // Zeros on both sides mean nothing is served: a distinct failure.
  if (isAllZero(browserBytes) && isAllZero(controlBytes)) return 'all-zero';
  for (let index = 0; index < browserBytes.length; index += 1) {
    if (browserBytes[index] !== controlBytes[index]) return 'content';
  }
  return null;
}

const RANGE_INTERCEPTED_HINT =
  'An HTTP cache, a service worker, or a proxy/antivirus is rewriting the response. ' +
  "Clear this site's data (DevTools > Application > Clear site data), unregister the " +
  'service worker for this origin, then reload.';

export function describeRangeDivergence(
  url: string,
  divergence: RangeByteDivergence,
  browserStatus: number,
  controlStatus: number,
): string {
  if (divergence === 'all-zero') {
    return (
      `The ranged read of ${url} returned only zero bytes on both transports ` +
      `(HTTP ${browserStatus} and ${controlStatus}): the file is served empty, or every ` +
      `layer between the disk and the page returns zeros. ${RANGE_INTERCEPTED_HINT}`
    );
  }
  return (
    `The ranged bytes served for ${url} differ between v86's transport (XMLHttpRequest, ` +
    `HTTP ${browserStatus}) and a no-store fetch (HTTP ${controlStatus}), or their sizes ` +
    `differ. ${RANGE_INTERCEPTED_HINT}`
  );
}

/** Control `fetch` no-store; divergent bytes prove a cache rewrites the disk. */
async function assertRangeBytesMatch(
  url: string,
  read: RangeProbeRead,
  signal: AbortSignal | undefined,
  ref: string,
  controlFetch: typeof fetch | null | undefined,
): Promise<void> {
  const browserBytes = read.bytes;
  if (browserBytes === null || read.length <= 0) return;
  // A zeroed browser block is accepted: the legacy probe cannot tell an empty
  // FAT region from a cache.
  if (isAllZero(browserBytes)) return;

  const fetchImpl = controlFetch === null ? undefined : (controlFetch ?? globalThis.fetch);
  if (typeof fetchImpl !== 'function') return;

  const end = read.offset + read.length - 1;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Range: `bytes=${read.offset}-${end}`, 'X-Accept-Encoding': 'identity' },
      cache: 'no-store',
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    // Cannot run the control request: keep the existing behaviour.
    return;
  }

  if (!canCompareBytes(response)) return;

  const browserStatus = read.status ?? 0;
  if (response.status !== browserStatus) {
    throw new AssetError(
      'ASSET_RANGE_UNAVAILABLE',
      `The ranged read of ${url} answered HTTP ${browserStatus} through v86's ` +
        `transport but HTTP ${response.status} through a no-store fetch. ${RANGE_INTERCEPTED_HINT}`,
      { ref },
    );
  }

  let controlBytes: Uint8Array;
  try {
    controlBytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    // The control body could not be read: no proof of corruption.
    return;
  }

  const divergence = detectRangeByteDivergence(browserBytes, controlBytes);
  if (divergence === null) return;

  throw new AssetError(
    'ASSET_RANGE_UNAVAILABLE',
    describeRangeDivergence(url, divergence, browserStatus, response.status),
    { ref },
  );
}

/** The disk is read by ranges for the whole boot: refuse a stalled boot early. */
async function assertDiskServedByRanges(
  manifest: ImageManifest,
  signal: AbortSignal | undefined,
  options: ImageManifestLoadOptions,
): Promise<void> {
  const disk = manifest.files['disk'];
  if (disk === undefined) return;

  // Same URL as the one v86 requests, `?v=<sha256>` included.
  const url = versionedMediaUrl(disk.url, disk.sha256);
  const probeOptions: RangeReadProbeOptions = {
    ...options.rangeProbeOptions,
    ...(signal === undefined ? {} : { signal }),
  };

  // An injected probe owns its own transport: no bytes to cross-check.
  if (options.rangeProbe !== undefined) {
    const probe = await options.rangeProbe(url, disk.size, probeOptions);
    if (probe.ok) return;
    throw new AssetError('ASSET_RANGE_UNAVAILABLE', probe.message, {
      ref: manifest.ref,
      ...(probe.cause === undefined ? {} : { cause: probe.cause }),
    });
  }

  const read = await readRangeProbe(url, disk.size, probeOptions);
  if (!read.outcome.ok) {
    throw new AssetError('ASSET_RANGE_UNAVAILABLE', read.outcome.message, {
      ref: manifest.ref,
      ...(read.outcome.cause === undefined ? {} : { cause: read.outcome.cause }),
    });
  }

  await assertRangeBytesMatch(url, read, signal, manifest.ref, options.controlFetch);
}

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
