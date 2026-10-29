import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetError } from './errors';
import { clearImageManifests, getImageManifest } from './manifest';
import {
  checkImageAvailability,
  describeRangeDivergence,
  detectRangeByteDivergence,
  ensureImageManifest,
  probeRangeRead,
  type RangeRequest,
} from './manifest-loader';

function validManifest(ref = 'debian-12-i386') {
  return {
    ref,
    architecture: 'i386',
    memoryMiB: 512,
    vgaMemoryMiB: 16,
    license: 'Debian GNU/Linux',
    files: {
      disk: { url: `/images/${ref}/rootfs.img`, sha256: 'a'.repeat(64), size: 100 },
      bzimage: { url: `/images/${ref}/vmlinuz-686`, sha256: 'b'.repeat(64), size: 20 },
      initrd: { url: `/images/${ref}/initrd.img`, sha256: 'c'.repeat(64), size: 30 },
    },
  };
}

/** Fake headers compatible with `Headers.get`. */
function fakeHeaders(record: Record<string, string>) {
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) lower[key.toLowerCase()] = value;
  return { get: (name: string): string | null => lower[name.toLowerCase()] ?? null };
}

function fakeResponse(payload: unknown, init: { status?: number; contentType?: string } = {}) {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: fakeHeaders({ 'content-type': init.contentType ?? 'application/json' }),
    json: async () => payload,
    body: null,
  } as unknown as Response;
}

function htmlResponse(status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: fakeHeaders({ 'content-type': 'text/html; charset=utf-8' }),
    json: async () => {
      throw new SyntaxError('Unexpected token <');
    },
    body: null,
  } as unknown as Response;
}

function rangeResponse(total: number) {
  return {
    ok: true,
    status: 206,
    headers: fakeHeaders({ 'content-range': `bytes 0-0/${total}` }),
    json: async () => ({}),
    body: null,
  } as unknown as Response;
}

function binaryResponse(status: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: fakeHeaders({ 'content-type': 'application/octet-stream' }),
    json: async () => ({}),
    body: null,
  } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Fake abort signal, to count listeners precisely. */
class FakeSignal {
  aborted = false;
  readonly #listeners = new Set<() => void>();

  addEventListener(type: string, listener: () => void): void {
    if (type === 'abort') this.#listeners.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === 'abort') this.#listeners.delete(listener);
  }

  dispatchAbort(): void {
    this.aborted = true;
    for (const listener of [...this.#listeners]) listener();
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }
}

function mockFetch(payload: unknown, ok = true, status = 200): typeof fetch {
  return vi.fn(async () => ({ ok, status, json: async () => payload })) as unknown as typeof fetch;
}

const DISK_SIZE = 100;
const DISK_URL = '/images/debian-12-i386/rootfs.img';
/** Same URL v86 requests: the provider appends `?v=<sha256 prefix>`. */
const VERSIONED_DISK_URL = `${DISK_URL}?v=${'a'.repeat(12)}`;

/** Minimal `XMLHttpRequest` stand-in: v86's transport is never `fetch`. */
class FakeXhr implements RangeRequest {
  timeout = 0;
  responseType: XMLHttpRequestResponseType = '';
  status = 0;
  response: ArrayBuffer | null = null;
  method = '';
  url = '';
  readonly requestHeaders: Record<string, string> = {};
  readonly responseHeaders: Record<string, string> = {};
  aborted = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.requestHeaders[name] = value;
  }

  getResponseHeader(name: string): string | null {
    return this.responseHeaders[name.toLowerCase()] ?? null;
  }

  send(): void {
    xhrPlan(this);
  }

  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }
}

/** Behaviour applied by `send()`. */
let xhrPlan: (request: FakeXhr) => void = plan206(DISK_SIZE);

/** Answers the requested range with a genuine 206 over `total` bytes. */
function plan206(total: number): (request: FakeXhr) => void {
  return (request) => {
    const match = /bytes=(\d+)-(\d+)/.exec(request.requestHeaders['Range'] ?? '');
    const from = Number(match?.[1] ?? 0);
    const to = Number(match?.[2] ?? 0);
    request.status = 206;
    request.responseHeaders['content-range'] = `bytes ${from}-${to}/${total}`;
    request.response = new ArrayBuffer(to - from + 1);
    request.onload?.();
  };
}

function probeDisk(size = 1_000_000) {
  return probeRangeRead(DISK_URL, size, { createRequest: () => new FakeXhr() });
}

beforeEach(() => {
  xhrPlan = plan206(DISK_SIZE);
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
});

afterEach(() => {
  clearImageManifests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ensureImageManifest', () => {
  it('loads, validates and registers a valid manifest', async () => {
    vi.stubGlobal('fetch', mockFetch(validManifest()));

    const manifest = await ensureImageManifest('debian-12-i386');

    expect(manifest.ref).toBe('debian-12-i386');
    expect(getImageManifest('debian-12-i386')).not.toBeNull();
  });

  it.each([
    '/images/../private/data',
    '/images/debian-12-i386/%2e%2e/data',
    '/images/other/disk.img',
  ])('rejects an unsafe or unrelated file URL: %s', async (url) => {
    const manifest = validManifest();
    manifest.files.disk.url = url;
    vi.stubGlobal('fetch', mockFetch(manifest));

    await expect(ensureImageManifest(manifest.ref)).rejects.toMatchObject({
      code: 'ASSET_INVALID_MANIFEST',
    });
  });

  it('rejects a boot binary URL outside the local engine directory', async () => {
    const manifest = { ...validManifest(), boot: { wasmPath: 'https://other.example/v86.wasm' } };
    vi.stubGlobal('fetch', mockFetch(manifest));
    await expect(ensureImageManifest(manifest.ref)).rejects.toMatchObject({
      code: 'ASSET_INVALID_MANIFEST',
    });
  });

  it('rejects a placeholder manifest (unknown fields and missing files)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        $comment: 'placeholder',
        ref: 'debian-12-i386',
        architecture: 'i386',
        memoryMiB: 512,
        license: 'x',
        files: {},
        status: 'not-built',
      }),
    );

    await expect(ensureImageManifest('debian-12-i386')).rejects.toMatchObject({
      code: 'ASSET_INVALID_MANIFEST',
    });
  });

  it('rejects a manifest reference different from the request', async () => {
    vi.stubGlobal('fetch', mockFetch(validManifest('other-image')));

    await expect(ensureImageManifest('debian-12-i386')).rejects.toMatchObject({
      code: 'ASSET_INVALID_MANIFEST',
    });
  });

  it('triggers a single request for concurrent calls', async () => {
    const fetchMock = mockFetch(validManifest());
    vi.stubGlobal('fetch', fetchMock);

    const [first, second] = await Promise.all([
      ensureImageManifest('debian-12-i386'),
      ensureImageManifest('debian-12-i386'),
    ]);

    expect(first.ref).toBe(second.ref);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid dynamic reference without a request', async () => {
    const fetchMock = mockFetch(validManifest());
    vi.stubGlobal('fetch', fetchMock);

    await expect(ensureImageManifest('../evil')).rejects.toMatchObject({
      code: 'ASSET_INVALID_MANIFEST',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('emits no request if the signal is already aborted', async () => {
    const fetchMock = mockFetch(validManifest());
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    controller.abort();

    await expect(ensureImageManifest('debian-12-i386', controller.signal)).rejects.toMatchObject({
      code: 'ASSET_ABORTED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does NOT interrupt the shared request when the first requester cancels', async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const gate = deferred<void>();
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal);
      await gate.promise;
      return fakeResponse(validManifest());
    });
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    const first = ensureImageManifest('debian-12-i386', controller.signal);
    const second = ensureImageManifest('debian-12-i386');

    controller.abort();
    await expect(first).rejects.toMatchObject({ code: 'ASSET_ABORTED' });
    // The remaining requester is not affected: the request stays alive.
    expect(signals[0]?.aborted).toBe(false);

    gate.resolve();
    await expect(second).resolves.toMatchObject({ ref: 'debian-12-i386' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('interrupts the request only when ALL requesters cancel, then reloads for the next one', async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    let call = 0;
    const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      call += 1;
      signals.push(init?.signal);
      if (call === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        });
      }
      return Promise.resolve(fakeResponse(validManifest()));
    });
    vi.stubGlobal('fetch', fetchMock);

    const a = new AbortController();
    const b = new AbortController();
    const first = ensureImageManifest('debian-12-i386', a.signal);
    const second = ensureImageManifest('debian-12-i386', b.signal);

    a.abort();
    b.abort();
    await expect(first).rejects.toMatchObject({ code: 'ASSET_ABORTED' });
    await expect(second).rejects.toMatchObject({ code: 'ASSET_ABORTED' });
    expect(signals[0]?.aborted).toBe(true);

    // Collective abandonment is never cached: a later call starts over.
    const retry = await ensureImageManifest('debian-12-i386');
    expect(retry.ref).toBe('debian-12-i386');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never caches a failure: a new call reloads', async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      return call === 1 ? fakeResponse({}, { status: 404 }) : fakeResponse(validManifest());
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(ensureImageManifest('debian-12-i386')).rejects.toMatchObject({
      code: 'ASSET_NOT_FOUND',
    });
    await expect(ensureImageManifest('debian-12-i386')).resolves.toMatchObject({
      ref: 'debian-12-i386',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('releases the abort listeners after resolution', async () => {
    const gate = deferred<void>();
    const fetchMock = vi.fn(async () => {
      await gate.promise;
      return fakeResponse(validManifest());
    });
    vi.stubGlobal('fetch', fetchMock);

    const signal = new FakeSignal();
    const promise = ensureImageManifest('debian-12-i386', signal as unknown as AbortSignal);
    expect(signal.listenerCount).toBe(1);

    gate.resolve();
    await promise;
    expect(signal.listenerCount).toBe(0);
  });

  it('releases the abort listeners after cancellation', async () => {
    const fetchMock = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const signal = new FakeSignal();
    const promise = ensureImageManifest('debian-12-i386', signal as unknown as AbortSignal);
    expect(signal.listenerCount).toBe(1);

    signal.dispatchAbort();
    await expect(promise).rejects.toMatchObject({ code: 'ASSET_ABORTED' });
    expect(signal.listenerCount).toBe(0);
  });
});

describe('checkImageAvailability', () => {
  it('declares the image available when the manifest is valid and the disk answers 206', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return fakeResponse(validManifest());
      return rangeResponse(100);
    });

    const result = await checkImageAvailability('debian-12-i386', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toMatchObject({ ref: 'debian-12-i386', available: true, size: 100 });
  });

  it('reports a missing manifest (404)', async () => {
    const fetchMock = vi.fn(async () => fakeResponse({}, { status: 404 }));

    const result = await checkImageAvailability('debian-12-i386', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toMatchObject({ available: false, reason: 'manifest-missing' });
  });

  it('reports an SPA HTML fallback instead of the JSON manifest', async () => {
    const fetchMock = vi.fn(async () => htmlResponse(200));

    const result = await checkImageAvailability('debian-12-i386', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toMatchObject({ available: false, reason: 'manifest-html' });
  });

  it('reports an unreadable JSON manifest', async () => {
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: fakeHeaders({ 'content-type': 'application/json' }),
          json: async () => {
            throw new SyntaxError('bad json');
          },
          body: null,
        }) as unknown as Response,
    );

    const result = await checkImageAvailability('debian-12-i386', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toMatchObject({ available: false, reason: 'manifest-invalid' });
  });

  it('reports a manifest outside the schema', async () => {
    const fetchMock = vi.fn(async () => fakeResponse({ ref: 'debian-12-i386' }));

    const result = await checkImageAvailability('debian-12-i386', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toMatchObject({ available: false, reason: 'manifest-schema' });
  });

  it('reports the lack of Range support (200 instead of 206)', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return fakeResponse(validManifest());
      return binaryResponse(200);
    });

    const result = await checkImageAvailability('debian-12-i386', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toMatchObject({ available: false, reason: 'range-unsupported' });
  });

  it('reports a missing disk (404)', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return fakeResponse(validManifest());
      return binaryResponse(404);
    });

    const result = await checkImageAvailability('debian-12-i386', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toMatchObject({ available: false, reason: 'disk-missing' });
  });
});

describe('probeRangeRead', () => {
  const SIZE = 1_000_000;

  it('accepts a real 206 whose Content-Range and body match the request', async () => {
    xhrPlan = plan206(SIZE);

    await expect(probeDisk(SIZE)).resolves.toEqual({ ok: true });
  });

  it('reads a non-zero offset with v86 headers and no cache directive', async () => {
    const requests: FakeXhr[] = [];
    xhrPlan = (request) => {
      requests.push(request);
      plan206(SIZE)(request);
    };

    await probeDisk(SIZE);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('GET');
    expect(requests[0]?.responseType).toBe('arraybuffer');
    // Exactly v86's contract: no `cache: 'no-store'`, no anti-cache parameter.
    expect(requests[0]?.requestHeaders).toEqual({
      Range: 'bytes=4096-8191',
      'X-Accept-Encoding': 'identity',
    });
  });

  it('fails on HTTP 200 with an actionable message', async () => {
    xhrPlan = (request) => {
      request.status = 200;
      request.response = new ArrayBuffer(SIZE);
      request.onload?.();
    };

    const outcome = await probeDisk(SIZE);

    expect(outcome).toMatchObject({ ok: false, reason: 'range-intercepted' });
    if (outcome.ok) throw new Error('expected a failure');
    expect(outcome.message).toContain('HTTP 200 instead of 206');
    expect(outcome.message).toContain('service worker');
    expect(outcome.message).toContain('Clear site data');
  });

  it('fails on HTTP 404', async () => {
    xhrPlan = (request) => {
      request.status = 404;
      request.onload?.();
    };

    await expect(probeDisk(SIZE)).resolves.toMatchObject({ ok: false, reason: 'disk-missing' });
  });

  it('fails on HTTP 416', async () => {
    xhrPlan = (request) => {
      request.status = 416;
      request.responseHeaders['content-range'] = `bytes */${SIZE}`;
      request.onload?.();
    };

    const outcome = await probeDisk(SIZE);

    expect(outcome).toMatchObject({ ok: false, reason: 'range-unsupported' });
    if (outcome.ok) throw new Error('expected a failure');
    expect(outcome.message).toContain('416');
  });

  it('fails when the body does not have the requested length', async () => {
    xhrPlan = (request) => {
      request.status = 206;
      request.responseHeaders['content-range'] = `bytes 4096-8191/${SIZE}`;
      request.response = new ArrayBuffer(10);
      request.onload?.();
    };

    const outcome = await probeDisk(SIZE);

    expect(outcome).toMatchObject({ ok: false, reason: 'disk-mismatch' });
    if (outcome.ok) throw new Error('expected a failure');
    expect(outcome.message).toContain('10 bytes instead of 4096');
  });

  it('fails when Content-Range describes another range', async () => {
    xhrPlan = (request) => {
      request.status = 206;
      request.responseHeaders['content-range'] = `bytes 0-4095/${SIZE}`;
      request.response = new ArrayBuffer(4096);
      request.onload?.();
    };

    await expect(probeDisk(SIZE)).resolves.toMatchObject({
      ok: false,
      reason: 'range-unsupported',
    });
  });

  it('fails on timeout', async () => {
    xhrPlan = (request) => request.ontimeout?.();

    const outcome = await probeDisk(SIZE);

    expect(outcome).toMatchObject({ ok: false, reason: 'network' });
    if (outcome.ok) throw new Error('expected a failure');
    expect(outcome.message).toContain('15 s');
  });

  it('fails on a transport error', async () => {
    xhrPlan = (request) => request.onerror?.();

    await expect(probeDisk(SIZE)).resolves.toMatchObject({ ok: false, reason: 'network' });
  });

  it('is a no-op when the environment has no XMLHttpRequest', async () => {
    vi.stubGlobal('XMLHttpRequest', undefined);

    await expect(probeRangeRead(DISK_URL, SIZE)).resolves.toEqual({ ok: true });
  });

  it('is a no-op when the request cannot even be opened', async () => {
    await expect(
      probeRangeRead(DISK_URL, SIZE, {
        createRequest: () => {
          const request = new FakeXhr();
          request.open = () => {
            throw new Error('Invalid URL');
          };
          return request;
        },
      }),
    ).resolves.toEqual({ ok: true });
  });
});

describe('ensureImageManifest range gate', () => {
  it('probes files.disk only, on the versioned URL v86 requests', async () => {
    vi.stubGlobal('fetch', mockFetch(validManifest()));
    const calls: Array<{ url: string; size: number }> = [];

    const manifest = await ensureImageManifest('debian-12-i386', undefined, {
      rangeProbe: async (url, size) => {
        calls.push({ url, size });
        return { ok: true };
      },
    });

    expect(manifest.ref).toBe('debian-12-i386');
    expect(calls).toEqual([{ url: VERSIONED_DISK_URL, size: DISK_SIZE }]);
  });

  it('refuses a cached HTTP 200 on the disk, does not register it, and re-probes later', async () => {
    vi.stubGlobal('fetch', mockFetch(validManifest()));
    xhrPlan = (request) => {
      request.status = 200;
      request.response = new ArrayBuffer(DISK_SIZE);
      request.onload?.();
    };

    const failure = await ensureImageManifest('debian-12-i386').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AssetError);
    expect(failure).toMatchObject({ code: 'ASSET_RANGE_UNAVAILABLE', ref: 'debian-12-i386' });
    expect((failure as AssetError).message).toContain(VERSIONED_DISK_URL);
    expect(getImageManifest('debian-12-i386')).toBeNull();

    // A healthy range path boots: the failure was never cached.
    xhrPlan = plan206(DISK_SIZE);
    await expect(ensureImageManifest('debian-12-i386')).resolves.toMatchObject({
      ref: 'debian-12-i386',
    });
    expect(getImageManifest('debian-12-i386')).not.toBeNull();
  });
});

describe('ensureImageManifest byte cross-check', () => {
  /** Non-zero pseudo-random block: a real disk never serves zeros here. */
  const REAL = Array.from({ length: DISK_SIZE }, (_, index) => (index % 251) + 1);

  function planBytes(payload: number[], total = DISK_SIZE): (request: FakeXhr) => void {
    return (request) => {
      const match = /bytes=(\d+)-(\d+)/.exec(request.requestHeaders['Range'] ?? '');
      const from = Number(match?.[1] ?? 0);
      request.status = 206;
      request.responseHeaders['content-range'] =
        `bytes ${from}-${from + payload.length - 1}/${total}`;
      request.response = Uint8Array.from(payload).buffer;
      request.onload?.();
    };
  }

  function byteResponse(payload: number[], status = 206, total = DISK_SIZE): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: fakeHeaders({ 'content-range': `bytes 0-${payload.length - 1}/${total}` }),
      arrayBuffer: async () => Uint8Array.from(payload).buffer,
      body: null,
    } as unknown as Response;
  }

  function controlFetch(payload: number[], status = 206): typeof fetch {
    return vi.fn(async () => byteResponse(payload, status)) as unknown as typeof fetch;
  }

  it('accepts identical bytes from XHR and from a no-store fetch', async () => {
    const fetchMock = mockFetch(validManifest());
    vi.stubGlobal('fetch', fetchMock);
    xhrPlan = planBytes(REAL);
    const control = controlFetch(REAL);

    const manifest = await ensureImageManifest('debian-12-i386', undefined, {
      controlFetch: control,
    });

    expect(manifest.ref).toBe('debian-12-i386');
    // Same range, same anti-cache contract as v86's request.
    const [url, init] = (
      control as unknown as {
        mock: { calls: Array<[string, RequestInit]> };
      }
    ).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(VERSIONED_DISK_URL);
    expect(init.method).toBe('GET');
    expect(init.cache).toBe('no-store');
    expect(init.headers).toEqual({ Range: 'bytes=0-99', 'X-Accept-Encoding': 'identity' });
  });

  it('rejects zeros replayed by a cache while XHR serves real bytes', async () => {
    vi.stubGlobal('fetch', mockFetch(validManifest()));
    xhrPlan = planBytes(REAL);

    const failure = await ensureImageManifest('debian-12-i386', undefined, {
      controlFetch: controlFetch(new Array<number>(DISK_SIZE).fill(0)),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AssetError);
    expect(failure).toMatchObject({ code: 'ASSET_RANGE_UNAVAILABLE', ref: 'debian-12-i386' });
    const message = (failure as AssetError).message;
    expect(message).toContain(VERSIONED_DISK_URL);
    expect(message).toContain('differ');
    expect(message).toContain('HTTP cache');
    expect(message).toContain('service worker');
    expect(message).toContain('proxy/antivirus');
    expect(message).toContain('Clear site data');
    // The broken manifest is not registered: a later boot re-probes.
    expect(getImageManifest('debian-12-i386')).toBeNull();
  });

  it('rejects different statuses for the same range', async () => {
    vi.stubGlobal('fetch', mockFetch(validManifest()));
    xhrPlan = planBytes(REAL);

    const failure = await ensureImageManifest('debian-12-i386', undefined, {
      controlFetch: controlFetch(REAL, 200),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AssetError);
    expect(failure).toMatchObject({ code: 'ASSET_RANGE_UNAVAILABLE' });
    const message = (failure as AssetError).message;
    expect(message).toContain('HTTP 206');
    expect(message).toContain('HTTP 200');
    expect(message).toContain('service worker');
  });

  it('distinguishes a file that is served empty on both transports', () => {
    // Both bodies all-zero: equal but meaningless, never a valid disk block.
    expect(detectRangeByteDivergence(new Uint8Array(4), new Uint8Array(4))).toBe('all-zero');
    const message = describeRangeDivergence('/images/x/disk.img', 'all-zero', 206, 206);
    expect(message).toContain('only zero bytes');
    expect(message).toContain('served empty');
    expect(message).not.toContain('differ');
  });

  it('is a no-op when the control transport is unavailable', async () => {
    vi.stubGlobal('fetch', mockFetch(validManifest()));
    xhrPlan = planBytes(REAL);

    await expect(
      ensureImageManifest('debian-12-i386', undefined, { controlFetch: null }),
    ).resolves.toMatchObject({ ref: 'debian-12-i386' });
  });

  it('is a no-op when the environment exposes no fetch at all', async () => {
    // The manifest is served, then `fetch` disappears: the guard must not throw.
    const fetchMock = vi.fn(async () => {
      vi.stubGlobal('fetch', undefined);
      return fakeResponse(validManifest());
    });
    vi.stubGlobal('fetch', fetchMock);
    xhrPlan = planBytes(REAL);

    await expect(ensureImageManifest('debian-12-i386')).resolves.toMatchObject({
      ref: 'debian-12-i386',
    });
  });

  it('is a no-op when XMLHttpRequest is unavailable', async () => {
    vi.stubGlobal('fetch', mockFetch(validManifest()));
    vi.stubGlobal('XMLHttpRequest', undefined);
    const control = vi.fn(async () => byteResponse(REAL));

    await expect(
      ensureImageManifest('debian-12-i386', undefined, {
        controlFetch: control as unknown as typeof fetch,
      }),
    ).resolves.toMatchObject({ ref: 'debian-12-i386' });
    // Without the XHR path there is nothing to compare with.
    expect(control).not.toHaveBeenCalled();
  });
});
