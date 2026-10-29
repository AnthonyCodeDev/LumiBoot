import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearDiskLog,
  defaultShouldHandleUrl,
  getDiskLog,
  getDiskSummary,
  installRangeFetchTransport,
  isRangeFetchTransportInstalled,
  type XhrScope,
} from './range-fetch-transport';
import { CDN_DISK_URL, CDN_DISK_URL_2 } from './testing/fixtures';

/** Minimal stand-in for the browser's `XMLHttpRequest`, never sent. */
class FakeOriginalXhr {
  static instances: FakeOriginalXhr[] = [];

  status = 0;
  statusText = '';
  readyState = 0;
  response: unknown = null;
  responseText = '';
  responseType: XMLHttpRequestResponseType = '';
  timeout = 0;
  withCredentials = false;
  method = '';
  url = '';
  body: unknown = null;
  readonly requestHeaders: Record<string, string> = {};
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  onload: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onabort: ((event: unknown) => void) | null = null;
  ontimeout: ((event: unknown) => void) | null = null;
  onprogress: ((event: unknown) => void) | null = null;
  onreadystatechange: ((event: unknown) => void) | null = null;

  constructor() {
    FakeOriginalXhr.instances.push(this);
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
    this.readyState = 1;
  }

  setRequestHeader(name: string, value: string): void {
    this.requestHeaders[name] = value;
  }

  getResponseHeader(name: string): string | null {
    return name.toLowerCase() === 'content-range'
      ? (this.requestHeaders['Content-Range'] ?? null)
      : null;
  }

  getAllResponseHeaders(): string {
    return '';
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set<(event: unknown) => void>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(body?: unknown): void {
    this.body = body;
  }

  abort(): void {
    this.readyState = 0;
  }
}

/** The subset of the XHR surface the transport must expose. */
interface TestXhr {
  readyState: number;
  status: number;
  statusText: string;
  response: unknown;
  responseText: string;
  responseType: XMLHttpRequestResponseType;
  timeout: number;
  withCredentials: boolean;
  onload: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onabort: ((event: unknown) => void) | null;
  ontimeout: ((event: unknown) => void) | null;
  onprogress: ((event: unknown) => void) | null;
  onreadystatechange: ((event: unknown) => void) | null;
  open(method: string, url: string, async?: boolean): void;
  setRequestHeader(name: string, value: string): void;
  send(body?: unknown): void;
  abort(): void;
  getResponseHeader(name: string): string | null;
  getAllResponseHeaders(): string;
  addEventListener(type: string, listener: (event: unknown) => void): void;
}

function fakeScope(): XhrScope {
  return { XMLHttpRequest: FakeOriginalXhr as unknown as typeof XMLHttpRequest };
}

function createRequest(scope: XhrScope): TestXhr {
  const Constructor = scope.XMLHttpRequest as unknown as new () => TestXhr;
  return new Constructor();
}

function headerBag(record: Record<string, string>): {
  get(name: string): string | null;
  forEach(callback: (value: string, key: string) => void): void;
} {
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) lower[key.toLowerCase()] = value;
  return {
    get: (name) => lower[name.toLowerCase()] ?? null,
    forEach: (callback) => {
      for (const [key, value] of Object.entries(lower)) callback(value, key);
    },
  };
}

function fakeResponse(
  status: number,
  bytes: Uint8Array,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'status',
    headers: headerBag(headers),
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response;
}

function rangedResponse(bytes: number[], total = 1024): Response {
  const body = Uint8Array.from(bytes);
  return fakeResponse(206, body, {
    'content-range': `bytes 0-${body.length - 1}/${total}`,
  });
}

function bytesOf(request: TestXhr): number[] {
  const response = request.response;
  return response instanceof ArrayBuffer ? [...new Uint8Array(response)] : [];
}

function once(request: TestXhr, type: 'load' | 'error' | 'abort' | 'timeout'): Promise<void> {
  return new Promise((resolve) => request.addEventListener(type, () => resolve()));
}

/** Prepares a ranged GET the same way v86 does. */
function prepare(request: TestXhr, url = '/images/debian/rootfs.img?v=abcdef123456'): TestXhr {
  request.open('GET', url, true);
  request.responseType = 'arraybuffer';
  request.setRequestHeader('Range', 'bytes=0-3');
  request.setRequestHeader('X-Accept-Encoding', 'identity');
  return request;
}

let uninstall: (() => void) | null = null;

function install(options: Parameters<typeof installRangeFetchTransport>[0]): () => void {
  uninstall = installRangeFetchTransport(options);
  return uninstall;
}

beforeEach(() => {
  clearDiskLog();
  FakeOriginalXhr.instances = [];
  expect(isRangeFetchTransportInstalled()).toBe(false);
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
  clearDiskLog();
  FakeOriginalXhr.instances = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('installRangeFetchTransport', () => {
  it('is a no-op when the environment has no XMLHttpRequest', () => {
    const stop = installRangeFetchTransport({ scope: {} });

    expect(isRangeFetchTransportInstalled()).toBe(false);
    expect(() => stop()).not.toThrow();
  });

  it('installs once and restores the exact original constructor', () => {
    const scope = fakeScope();
    const original = scope.XMLHttpRequest;
    const first = install({ scope, fetchImpl: vi.fn() as unknown as typeof fetch });
    const second = installRangeFetchTransport({ scope });

    // Idempotent: the same installation and the same uninstall function.
    expect(second).toBe(first);
    expect(isRangeFetchTransportInstalled()).toBe(true);
    expect(scope.XMLHttpRequest).not.toBe(original);

    first();

    expect(scope.XMLHttpRequest).toBe(original);
    expect(isRangeFetchTransportInstalled()).toBe(false);
  });

  it('keeps `instanceof XMLHttpRequest` true for both paths', () => {
    const scope = fakeScope();
    install({ scope, fetchImpl: vi.fn() as unknown as typeof fetch });
    const Transport = scope.XMLHttpRequest as unknown as typeof XMLHttpRequest;

    const request = createRequest(scope);
    const passthrough = createRequest(scope);
    passthrough.open('GET', '/images/debian/manifest.json');
    passthrough.send(null);

    expect(request instanceof Transport).toBe(true);
    // The real request created for a pass-through is still recognised too.
    expect(FakeOriginalXhr.instances[0] instanceof Transport).toBe(true);
  });

  it('exposes window.__lumibootDiagnostics', () => {
    const scope = fakeScope();
    install({ scope, fetchImpl: vi.fn() as unknown as typeof fetch });

    expect(typeof window.__lumibootDiagnostics?.diskLog).toBe('function');
    expect(typeof window.__lumibootDiagnostics?.diskSummary).toBe('function');
  });
});

describe('passthrough', () => {
  it('uses the original XHR when the request carries no Range header', () => {
    const scope = fakeScope();
    const fetchImpl = vi.fn() as unknown as typeof fetch & { mock: { calls: unknown[] } };
    install({ scope, fetchImpl });

    const request = createRequest(scope);
    request.open('GET', '/images/debian/manifest.json');
    request.send(null);

    expect(FakeOriginalXhr.instances).toHaveLength(1);
    expect(FakeOriginalXhr.instances[0]?.url).toBe('/images/debian/manifest.json');
    expect(fetchImpl.mock.calls).toHaveLength(0);
  });

  it('uses the original XHR for a cross-origin ranged request', () => {
    const scope = fakeScope();
    const fetchImpl = vi.fn() as unknown as typeof fetch & { mock: { calls: unknown[] } };
    install({ scope, fetchImpl });

    const request = createRequest(scope);
    request.open('GET', CDN_DISK_URL, true);
    request.setRequestHeader('Range', 'bytes=0-3');
    request.send(null);

    expect(FakeOriginalXhr.instances).toHaveLength(1);
    expect(FakeOriginalXhr.instances[0]?.requestHeaders['Range']).toBe('bytes=0-3');
    expect(fetchImpl.mock.calls).toHaveLength(0);
  });

  it('honours a custom predicate and replays the request unchanged', () => {
    const scope = fakeScope();
    const fetchImpl = vi.fn() as unknown as typeof fetch & { mock: { calls: unknown[] } };
    install({ scope, fetchImpl, shouldHandleUrl: () => false });

    const request = createRequest(scope);
    request.responseType = 'arraybuffer';
    request.timeout = 1234;
    request.withCredentials = true;
    prepare(request);
    request.send(null);

    const delegate = FakeOriginalXhr.instances[0];
    expect(delegate?.responseType).toBe('arraybuffer');
    expect(delegate?.timeout).toBe(1234);
    expect(delegate?.withCredentials).toBe(true);
    expect(delegate?.requestHeaders).toEqual({
      Range: 'bytes=0-3',
      'X-Accept-Encoding': 'identity',
    });
    expect(fetchImpl.mock.calls).toHaveLength(0);
  });
});

describe('fetch transport', () => {
  it('serves a 206 through fetch with cache: no-store', async () => {
    const scope = fakeScope();
    const fetchImpl = vi.fn(async () => rangedResponse([1, 2, 3, 4]));
    install({ scope, fetchImpl: fetchImpl as unknown as typeof fetch });

    const request = prepare(createRequest(scope));
    const loaded = once(request, 'load');
    request.send(null);
    await loaded;

    expect(request.status).toBe(206);
    expect(request.readyState).toBe(4);
    expect(request.getResponseHeader('Content-Range')).toBe('bytes 0-3/1024');
    expect(bytesOf(request)).toEqual([1, 2, 3, 4]);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/images/debian/rootfs.img?v=abcdef123456');
    expect(init.cache).toBe('no-store');
    expect(init.credentials).toBe('same-origin');
    expect(init.headers).toEqual({ Range: 'bytes=0-3', 'X-Accept-Encoding': 'identity' });
  });

  it('relays an HTTP 200 honestly so v86 and the diagnostics see it', async () => {
    const scope = fakeScope();
    const fetchImpl = vi.fn(async () =>
      fakeResponse(200, Uint8Array.from([9, 9, 9, 9]), {
        'content-type': 'application/octet-stream',
      }),
    );
    install({ scope, fetchImpl: fetchImpl as unknown as typeof fetch });

    const request = prepare(createRequest(scope));
    let seenStatus = -1;
    request.onreadystatechange = () => {
      if (request.readyState === 4) seenStatus = request.status;
    };
    const loaded = once(request, 'load');
    request.send(null);
    await loaded;

    expect(request.status).toBe(200);
    // v86 aborts on 200 from `onreadystatechange`: status must be readable at DONE.
    expect(seenStatus).toBe(200);
    expect(getDiskLog().at(-1)).toMatchObject({
      status: 200,
      byteLength: 4,
      transport: 'fetch',
      allZero: false,
    });
  });

  it('lets v86 abort a 200 from onreadystatechange, as its source does', async () => {
    const scope = fakeScope();
    install({
      scope,
      fetchImpl: (async () => fakeResponse(200, Uint8Array.from([9, 9, 9, 9]))) as typeof fetch,
    });

    const request = prepare(createRequest(scope));
    let loadCalls = 0;
    // Exact v86 0.5.471 handler: a full file aborts the ranged request.
    request.onreadystatechange = () => {
      if (request.status === 200) request.abort();
    };
    request.onload = () => {
      loadCalls += 1;
    };
    const aborted = once(request, 'abort');
    request.send(null);
    await aborted;

    expect(loadCalls).toBe(0);
    // The diagnostics still record the status the browser really got.
    expect(getDiskLog().at(-1)?.status).toBe(200);
  });

  it('fires onerror and never leaves a pending request on a network error', async () => {
    const scope = fakeScope();
    install({
      scope,
      fetchImpl: (async () => {
        throw new TypeError('Failed to fetch');
      }) as typeof fetch,
    });

    const request = prepare(createRequest(scope));
    const failed = once(request, 'error');
    request.send(null);
    await failed;

    expect(request.readyState).toBe(4);
    expect(request.status).toBe(0);
    expect(getDiskLog().at(-1)).toMatchObject({
      status: null,
      error: 'Failed to fetch',
      transport: 'fetch',
    });
  });

  it('fires onabort and suppresses the late load', async () => {
    const scope = fakeScope();
    let settle: ((response: Response) => void) | undefined;
    install({
      scope,
      fetchImpl: (() =>
        new Promise<Response>((resolve) => {
          settle = resolve;
        })) as typeof fetch,
    });

    const request = prepare(createRequest(scope));
    let loadCalls = 0;
    request.onload = () => {
      loadCalls += 1;
    };
    const aborted = once(request, 'abort');
    request.send(null);
    request.abort();
    await aborted;

    settle?.(rangedResponse([1, 2, 3, 4]));
    // Two microtask turns: the fetch resolution must not resurrect the request.
    await Promise.resolve();
    await Promise.resolve();

    expect(loadCalls).toBe(0);
    expect(request.readyState).toBe(4);
  });

  it('fires ontimeout when the server never answers', async () => {
    vi.useFakeTimers();
    const scope = fakeScope();
    install({
      scope,
      fetchImpl: (() => new Promise<Response>(() => undefined)) as typeof fetch,
    });

    const request = prepare(createRequest(scope));
    request.timeout = 50;
    const timedOut = once(request, 'timeout');
    request.send(null);
    vi.advanceTimersByTime(50);
    await timedOut;

    expect(request.readyState).toBe(4);
    expect(getDiskLog().at(-1)?.status).toBeNull();
  });

  it('supports the addEventListener style as well as the on* properties', async () => {
    const scope = fakeScope();
    install({ scope, fetchImpl: (async () => rangedResponse([1, 2, 3, 4])) as typeof fetch });

    const request = prepare(createRequest(scope));
    const events: string[] = [];
    let progressLoaded = -1;
    request.addEventListener('progress', (event) => {
      progressLoaded = (event as { loaded: number }).loaded;
    });
    request.addEventListener('load', () => events.push('load'));
    const loaded = once(request, 'load');
    request.send(null);
    await loaded;

    expect(events).toEqual(['load']);
    expect(progressLoaded).toBe(4);
  });

  it('records allZero when every byte is zero', async () => {
    const scope = fakeScope();
    install({ scope, fetchImpl: (async () => rangedResponse([0, 0, 0, 0])) as typeof fetch });

    const request = prepare(createRequest(scope));
    const loaded = once(request, 'load');
    request.send(null);
    await loaded;

    const entry = getDiskLog().at(-1);
    expect(entry?.allZero).toBe(true);
    expect(entry?.status).toBe(206);
    expect(entry?.range).toBe('bytes=0-3');
    expect(entry?.contentRange).toBe('bytes 0-3/1024');
    expect(entry?.byteLength).toBe(4);
    expect(typeof entry?.durationMs).toBe('number');
  });

  it('summarises statuses, all-zero reads and transport usage', async () => {
    const scope = fakeScope();
    let answer: Response = rangedResponse([0, 0, 0, 0]);
    install({ scope, fetchImpl: (async () => answer) as typeof fetch });

    const first = prepare(createRequest(scope));
    let loaded = once(first, 'load');
    first.send(null);
    await loaded;

    answer = fakeResponse(200, Uint8Array.from([1, 2, 3, 4]));
    const second = prepare(createRequest(scope));
    loaded = once(second, 'load');
    second.send(null);
    await loaded;

    const summary = getDiskSummary();
    expect(summary.requests).toBe(2);
    expect(summary.byStatus).toEqual({ '206': 1, '200': 1 });
    expect(summary.allZero).toBe(1);
    expect(summary.transports).toEqual({ fetch: 2, xhr: 0 });
    expect(summary.serviceWorkerUrl).toBeNull();
    expect(typeof summary.userAgent).toBe('string');
  });
});

describe('defaultShouldHandleUrl', () => {
  it('requires GET, a Range header and the same origin', () => {
    expect(defaultShouldHandleUrl('/images/a.img', 'GET', { Range: 'bytes=0-3' })).toBe(true);
    expect(defaultShouldHandleUrl('/images/a.img', 'get', { Range: 'bytes=0-3' })).toBe(true);
    expect(defaultShouldHandleUrl('/images/a.img', 'GET', {})).toBe(false);
    expect(defaultShouldHandleUrl('/images/a.img', 'POST', { Range: 'bytes=0-3' })).toBe(false);
    expect(defaultShouldHandleUrl(CDN_DISK_URL_2, 'GET', { Range: 'bytes=0-3' })).toBe(false);
  });
});
