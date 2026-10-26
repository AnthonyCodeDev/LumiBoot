import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearImageManifests, getImageManifest } from './manifest';
import { checkImageAvailability, ensureImageManifest } from './manifest-loader';

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
    // The remaining requester is NOT affected: the internal request stays alive.
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
