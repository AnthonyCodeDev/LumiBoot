/**
 * v86 0.5.x reads every disk block with `XMLHttpRequest` + a `Range` header and
 * exposes no `FileStorage` injection point: replacing the request constructor
 * before v86 is imported is the only interception point.
 *
 * Disk ranges are replayed through `fetch(..., { cache: 'no-store' })`, so a
 * stale HTTP cache entry or a cached service-worker response cannot feed zeros
 * to the guest. Every other request is handed to the original constructor with
 * its state replayed unchanged.
 *
 * Known limit: `fetch` is still observable by a service worker for this origin.
 * A service worker that rewrites the ranged response can return wrong bytes
 * through this transport too; the diagnostics below make that case visible
 * (`status !== 206`, `allZero`, `Content-Range`) without DevTools.
 */

/** Transport that actually served one disk request. */
export type DiskRequestTransport = 'fetch' | 'xhr';

/** One ranged (or disk-shaped) request, kept for the UI diagnostics panel. */
export interface DiskRequestLogEntry {
  /** Wall-clock timestamp (`Date.now()`), so a pasted report is readable. */
  readonly at: number;
  readonly url: string;
  /** `Range` request header, verbatim. */
  readonly range: string | null;
  /** HTTP status observed, or `null` before any response. */
  readonly status: number | null;
  readonly contentRange: string | null;
  readonly byteLength: number | null;
  readonly durationMs: number;
  /** `true` when every byte of the body is zero; `null` when unknown/empty. */
  readonly allZero: boolean | null;
  readonly transport: DiskRequestTransport;
  /** `true` when the fetch transport was unavailable and XHR was used. */
  readonly fallback: boolean;
  readonly error?: string;
}

/** Counters exposed to the UI and to `window.__lumibootDiagnostics`. */
export interface DiskDiagnosticsSummary {
  readonly requests: number;
  /** `'206'`, `'200'`, `'error'`, `'pending'`... */
  readonly byStatus: Readonly<Record<string, number>>;
  readonly allZero: number;
  readonly fallbacks: number;
  readonly transports: Readonly<Record<DiskRequestTransport, number>>;
  readonly serviceWorkerUrl: string | null;
  readonly userAgent: string;
  readonly lastRequestAt: number | null;
}

export interface LumibootDiskDiagnostics {
  diskLog(): DiskRequestLogEntry[];
  diskSummary(): DiskDiagnosticsSummary;
}

declare global {
  interface Window {
    __lumibootDiagnostics?: LumibootDiskDiagnostics;
  }
}

/** Ring buffer size: enough to spot a systematic pattern, cheap to copy. */
const DISK_LOG_LIMIT = 200;

interface MutableDiskEntry {
  at: number;
  url: string;
  range: string | null;
  status: number | null;
  contentRange: string | null;
  byteLength: number | null;
  durationMs: number;
  allZero: boolean | null;
  transport: DiskRequestTransport;
  fallback: boolean;
  error?: string;
}

const diskLog: MutableDiskEntry[] = [];

function recordDiskRequest(entry: MutableDiskEntry): void {
  diskLog.push(entry);
  if (diskLog.length > DISK_LOG_LIMIT) {
    diskLog.splice(0, diskLog.length - DISK_LOG_LIMIT);
  }
}

/** Oldest first. Copies are returned so callers cannot mutate the buffer. */
export function getDiskLog(): DiskRequestLogEntry[] {
  return diskLog.map((entry) => ({ ...entry }));
}

/** Clears the ring buffer (tests, and a fresh session if ever needed). */
export function clearDiskLog(): void {
  diskLog.length = 0;
}

function controllerServiceWorkerUrl(): string | null {
  if (typeof navigator === 'undefined') return null;
  const container = (navigator as Navigator & { serviceWorker?: ServiceWorkerContainer })
    .serviceWorker;
  return container?.controller?.scriptURL ?? null;
}

export function getDiskSummary(): DiskDiagnosticsSummary {
  const byStatus: Record<string, number> = {};
  const transports: Record<DiskRequestTransport, number> = { fetch: 0, xhr: 0 };
  let allZero = 0;
  let fallbacks = 0;
  for (const entry of diskLog) {
    const key =
      entry.status === null
        ? entry.error === undefined
          ? 'pending'
          : 'error'
        : String(entry.status);
    byStatus[key] = (byStatus[key] ?? 0) + 1;
    transports[entry.transport] += 1;
    if (entry.allZero === true) allZero += 1;
    if (entry.fallback) fallbacks += 1;
  }
  return {
    requests: diskLog.length,
    byStatus,
    allZero,
    fallbacks,
    transports,
    serviceWorkerUrl: controllerServiceWorkerUrl(),
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    lastRequestAt: diskLog.length === 0 ? null : (diskLog[diskLog.length - 1]?.at ?? null),
  };
}

/** Exposes the buffer to the page; the session UI reads the module directly. */
export function installDiagnosticsGlobal(): void {
  if (typeof window === 'undefined') return;
  window.__lumibootDiagnostics = {
    diskLog: getDiskLog,
    diskSummary: getDiskSummary,
  };
}

/* --------------------------------------------------------------------------
 * Request decision
 * ------------------------------------------------------------------------ */

export type HeaderRecord = Record<string, string>;

/** Default policy: same-origin GET carrying a `Range` header — the header decides. */
export type ShouldHandleUrl = (url: string, method: string, headers: HeaderRecord) => boolean;

function headerLookup(headers: HeaderRecord, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return null;
}

function sameOrigin(url: string): boolean {
  if (typeof location === 'undefined') return false;
  try {
    return new URL(url, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

/** `.img`/`.iso`/`.raw` media are logged even without a `Range` header. */
const DISK_MEDIA_URL = /\.(img|iso|raw)(?:$|[?#])|\/images\//i;

function isDiskMediaUrl(url: string): boolean {
  return DISK_MEDIA_URL.test(url);
}

export const defaultShouldHandleUrl: ShouldHandleUrl = (url, method, headers) =>
  method.toUpperCase() === 'GET' && headerLookup(headers, 'Range') !== null && sameOrigin(url);

/* --------------------------------------------------------------------------
 * XHR-compatible request surface
 * ------------------------------------------------------------------------ */

const READY_STATE = {
  UNSENT: 0,
  OPENED: 1,
  HEADERS_RECEIVED: 2,
  LOADING: 3,
  DONE: 4,
} as const;

type TransportEventType =
  'load' | 'error' | 'timeout' | 'abort' | 'progress' | 'readystatechange' | 'loadend';

const HANDLER_EVENTS: readonly TransportEventType[] = [
  'load',
  'error',
  'timeout',
  'abort',
  'progress',
  'readystatechange',
  'loadend',
];

type EventHandler = ((event: unknown) => void) | null;

interface HeaderBag {
  get(name: string): string | null;
  forEach?(callback: (value: string, key: string) => void): void;
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function isAllZeroBytes(bytes: Uint8Array): boolean {
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) return false;
  }
  return true;
}

/** An empty body is unknown, not "all zero". */
function measureAllZero(bytes: Uint8Array): boolean | null {
  return bytes.length === 0 ? null : isAllZeroBytes(bytes);
}

function createEvent(type: string): unknown {
  try {
    if (typeof Event === 'function') return new Event(type);
  } catch {
    /* fall through to a plain object */
  }
  return { type };
}

function createProgressEvent(type: string, loaded: number, total: number): unknown {
  try {
    if (typeof ProgressEvent === 'function') {
      return new ProgressEvent(type, { lengthComputable: total > 0, loaded, total });
    }
  } catch {
    /* fall through to a plain object */
  }
  return { type, lengthComputable: total > 0, loaded, total };
}

function decodeText(bytes: Uint8Array): string {
  if (typeof TextDecoder === 'function') return new TextDecoder().decode(bytes);
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

function readContentRange(headers: HeaderBag | undefined): string | null {
  if (headers === undefined || typeof headers.get !== 'function') return null;
  try {
    return headers.get('content-range');
  } catch {
    return null;
  }
}

interface TransportEnvironment {
  readonly original: typeof XMLHttpRequest;
  readonly shouldHandleUrl: ShouldHandleUrl;
  readonly fetchImpl: typeof fetch | undefined;
}

/**
 * XHR-shaped facade. It answers through `fetch` for disk ranges and creates a
 * real `XMLHttpRequest` for everything else, replaying the recorded state so the
 * original behaviour is preserved.
 */
class RangeFetchRequest {
  #env: TransportEnvironment;

  #delegate: XMLHttpRequest | null = null;
  #method = 'GET';
  #url = '';
  #body: Document | XMLHttpRequestBodyInit | null = null;
  #requestHeaders: Array<[string, string]> = [];
  #listeners = new Map<string, Set<(event: unknown) => void>>();

  #readyState: number = READY_STATE.UNSENT;
  #status = 0;
  #statusText = '';
  #response: unknown = null;
  #responseText = '';
  #responseHeaders: HeaderBag | null = null;

  #responseType: XMLHttpRequestResponseType = '';
  #timeout = 0;
  #withCredentials = false;

  #controller: AbortController | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #sent = false;
  #finished = false;
  #entry: MutableDiskEntry | null = null;
  #startedAt = 0;

  /**
   * Handlers live in one record rather than in per-instance accessors: v86
   * issues thousands of reads, so the facade must stay allocation-free.
   */
  #handlers: Record<TransportEventType, EventHandler> = {
    load: null,
    error: null,
    timeout: null,
    abort: null,
    progress: null,
    readystatechange: null,
    loadend: null,
  };

  constructor(env: TransportEnvironment) {
    this.#env = env;
  }

  get onload(): EventHandler {
    return this.#handlers.load;
  }

  set onload(handler: EventHandler) {
    this.#setHandler('load', handler);
  }

  get onerror(): EventHandler {
    return this.#handlers.error;
  }

  set onerror(handler: EventHandler) {
    this.#setHandler('error', handler);
  }

  get ontimeout(): EventHandler {
    return this.#handlers.timeout;
  }

  set ontimeout(handler: EventHandler) {
    this.#setHandler('timeout', handler);
  }

  get onabort(): EventHandler {
    return this.#handlers.abort;
  }

  set onabort(handler: EventHandler) {
    this.#setHandler('abort', handler);
  }

  get onprogress(): EventHandler {
    return this.#handlers.progress;
  }

  set onprogress(handler: EventHandler) {
    this.#setHandler('progress', handler);
  }

  get onreadystatechange(): EventHandler {
    return this.#handlers.readystatechange;
  }

  set onreadystatechange(handler: EventHandler) {
    this.#setHandler('readystatechange', handler);
  }

  get onloadend(): EventHandler {
    return this.#handlers.loadend;
  }

  set onloadend(handler: EventHandler) {
    this.#setHandler('loadend', handler);
  }

  #setHandler(type: TransportEventType, handler: EventHandler): void {
    this.#handlers[type] = handler;
    const delegate = this.#delegate;
    if (delegate === null) return;
    (delegate as unknown as Record<string, unknown>)[`on${type}`] = handler;
  }

  get readyState(): number {
    return this.#delegate?.readyState ?? this.#readyState;
  }

  get status(): number {
    return this.#delegate?.status ?? this.#status;
  }

  get statusText(): string {
    return this.#delegate?.statusText ?? this.#statusText;
  }

  get response(): unknown {
    return this.#delegate === null ? this.#response : this.#delegate.response;
  }

  get responseText(): string {
    return this.#delegate === null ? this.#responseText : this.#delegate.responseText;
  }

  get responseURL(): string {
    return this.#delegate?.responseURL ?? '';
  }

  get responseXML(): Document | null {
    return this.#delegate === null ? null : this.#delegate.responseXML;
  }

  get responseType(): XMLHttpRequestResponseType {
    return this.#delegate === null ? this.#responseType : this.#delegate.responseType;
  }

  set responseType(value: XMLHttpRequestResponseType) {
    this.#responseType = value;
    if (this.#delegate !== null) this.#delegate.responseType = value;
  }

  get timeout(): number {
    return this.#delegate === null ? this.#timeout : this.#delegate.timeout;
  }

  set timeout(value: number) {
    this.#timeout = value;
    if (this.#delegate !== null) this.#delegate.timeout = value;
  }

  get withCredentials(): boolean {
    return this.#delegate === null ? this.#withCredentials : this.#delegate.withCredentials;
  }

  set withCredentials(value: boolean) {
    this.#withCredentials = value;
    if (this.#delegate !== null) this.#delegate.withCredentials = value;
  }

  open(
    method: string,
    url: string,
    async = true,
    user?: string | null,
    password?: string | null,
  ): void {
    if (this.#delegate !== null) {
      this.#delegate.open(method, url, async, user, password);
      return;
    }
    this.#method = method;
    this.#url = url;
    this.#setReadyState(READY_STATE.OPENED);
  }

  setRequestHeader(name: string, value: string): void {
    if (this.#delegate !== null) {
      this.#delegate.setRequestHeader(name, value);
      return;
    }
    this.#requestHeaders.push([name, String(value)]);
  }

  getResponseHeader(name: string): string | null {
    if (this.#delegate !== null) return this.#delegate.getResponseHeader(name);
    return this.#responseHeaders?.get(name) ?? null;
  }

  getAllResponseHeaders(): string {
    if (this.#delegate !== null) return this.#delegate.getAllResponseHeaders();
    const headers = this.#responseHeaders;
    if (headers === null) return '';
    let output = '';
    const collect = (value: string, key: string): void => {
      output += `${key}: ${value}\r\n`;
    };
    if (typeof headers.forEach === 'function') headers.forEach(collect);
    return output;
  }

  addEventListener(type: string, listener: EventHandler): void {
    if (typeof listener !== 'function') return;
    const delegate = this.#delegate;
    if (delegate === null) {
      const set = this.#listeners.get(type) ?? new Set<(event: unknown) => void>();
      set.add(listener);
      this.#listeners.set(type, set);
      return;
    }
    delegate.addEventListener(type, listener as (event: Event) => void);
  }

  removeEventListener(type: string, listener: EventHandler): void {
    if (typeof listener !== 'function') return;
    if (this.#delegate === null) {
      this.#listeners.get(type)?.delete(listener);
      return;
    }
    this.#delegate.removeEventListener(type, listener as (event: Event) => void);
  }

  send(body?: Document | XMLHttpRequestBodyInit | null): void {
    if (this.#delegate !== null) {
      this.#delegate.send(body ?? null);
      return;
    }
    this.#body = body ?? null;
    this.#sent = true;
    this.#startedAt = nowMs();

    const headers = this.#headerRecord();
    if (!this.#env.shouldHandleUrl(this.#url, this.#method, headers)) {
      this.#passthrough(false);
      return;
    }
    this.#runFetch();
  }

  abort(): void {
    const delegate = this.#delegate;
    if (delegate !== null) {
      try {
        delegate.abort();
      } catch {
        /* already finished */
      }
      return;
    }
    if (this.#finished) return;
    if (!this.#sent) {
      this.#readyState = READY_STATE.UNSENT;
      return;
    }
    this.#controller?.abort();
    this.#finish('abort');
  }

  /* ---------------------------------------------------------------------- */

  #headerRecord(): HeaderRecord {
    const headers: HeaderRecord = {};
    for (const [name, value] of this.#requestHeaders) headers[name] = value;
    return headers;
  }

  #requestHeader(name: string): string | null {
    return headerLookup(this.#headerRecord(), name);
  }

  #setReadyState(state: number): void {
    if (this.#delegate !== null) return;
    // Native XHR never repeats a state transition.
    if (this.#readyState === state) return;
    this.#readyState = state;
    this.#emit('readystatechange');
  }

  #emit(type: TransportEventType): void {
    const event =
      type === 'progress'
        ? createProgressEvent('progress', this.#byteLength(), this.#byteLength())
        : createEvent(type);
    this.#handlers[type]?.call(this, event);
    const listeners = this.#listeners.get(type);
    if (listeners === undefined) return;
    for (const listener of [...listeners]) {
      try {
        listener.call(this, event);
      } catch {
        /* a listener must never break the transport */
      }
    }
  }

  #byteLength(): number {
    const response = this.#response;
    if (response instanceof ArrayBuffer) return response.byteLength;
    if (typeof response === 'string') return response.length;
    return 0;
  }

  /** Settles once: readystatechange(DONE), the event itself, then loadend. */
  #finish(type: 'load' | 'error' | 'timeout' | 'abort'): void {
    if (this.#finished) return;
    this.#finished = true;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#readyState !== READY_STATE.DONE) {
      this.#readyState = READY_STATE.DONE;
      this.#emit('readystatechange');
    }
    if (type === 'load') this.#emit('progress');
    this.#emit(type);
    this.#emit('loadend');
  }

  #applyBody(buffer: ArrayBuffer): void {
    const bytes = new Uint8Array(buffer);
    const type = this.#responseType;
    if (type === 'json') {
      try {
        this.#response = JSON.parse(decodeText(bytes)) as unknown;
      } catch {
        this.#response = null;
      }
      return;
    }
    if (type === 'blob') {
      this.#response = typeof Blob === 'function' ? new Blob([bytes]) : buffer;
      return;
    }
    if (type === 'arraybuffer') {
      this.#response = buffer;
      return;
    }
    this.#responseText = decodeText(bytes);
    this.#response = this.#responseText;
  }

  #logHeaders(response: Response, started: number): void {
    const entry: MutableDiskEntry = {
      at: Date.now(),
      url: this.#url,
      range: this.#requestHeader('Range'),
      status: response.status,
      contentRange: readContentRange(response.headers),
      byteLength: null,
      durationMs: Math.round(nowMs() - started),
      allZero: null,
      transport: 'fetch',
      fallback: false,
    };
    this.#entry = entry;
    recordDiskRequest(entry);
  }

  #completeLog(buffer: ArrayBuffer): void {
    const entry = this.#entry;
    if (entry === null) return;
    const bytes = new Uint8Array(buffer);
    entry.byteLength = bytes.byteLength;
    entry.allZero = measureAllZero(bytes);
    entry.durationMs = Math.round(nowMs() - this.#startedAt);
  }

  #failLog(error: unknown, transport: DiskRequestTransport = 'fetch', fallback = false): void {
    const message = error instanceof Error ? error.message : String(error);
    const entry = this.#entry;
    if (entry !== null) {
      entry.error = message;
      entry.durationMs = Math.round(nowMs() - this.#startedAt);
      return;
    }
    recordDiskRequest({
      at: Date.now(),
      url: this.#url,
      range: this.#requestHeader('Range'),
      status: null,
      contentRange: null,
      byteLength: null,
      durationMs: Math.round(nowMs() - this.#startedAt),
      allZero: null,
      transport,
      fallback,
      error: message,
    });
  }

  #runFetch(): void {
    const fetchImpl = this.#env.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
    if (fetchImpl === undefined) {
      // No fetch here (older environment): the original transport still works.
      this.#passthrough(true);
      return;
    }

    const started = this.#startedAt;
    const controller = new AbortController();
    this.#controller = controller;
    this.#setReadyState(READY_STATE.OPENED);

    if (this.#timeout > 0) {
      this.#timer = setTimeout(() => {
        this.#failLog(new Error(`timed out after ${this.#timeout} ms`));
        controller.abort();
        this.#finish('timeout');
      }, this.#timeout);
    }

    let pending: Promise<Response>;
    try {
      pending = fetchImpl(this.#url, {
        method: this.#method === '' ? 'GET' : this.#method,
        headers: this.#headerRecord(),
        // The whole point: never let the HTTP cache answer a disk range.
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'follow',
        signal: controller.signal,
      });
    } catch (error) {
      // A transport refusing the request must behave like XHR, never throw here.
      this.#failLog(error);
      this.#finish('error');
      return;
    }

    void pending
      .then(async (response) => {
        if (this.#finished) return;
        this.#status = response.status;
        this.#statusText = response.statusText;
        this.#responseHeaders = response.headers;
        this.#logHeaders(response, started);
        this.#setReadyState(READY_STATE.HEADERS_RECEIVED);
        const buffer = await response.arrayBuffer();
        if (this.#finished) return;
        this.#applyBody(buffer);
        this.#completeLog(buffer);
        this.#setReadyState(READY_STATE.LOADING);
        this.#finish('load');
      })
      .catch((error: unknown) => {
        if (this.#finished) return;
        this.#failLog(error);
        this.#finish('error');
      });
  }

  /** Hands the request to the original constructor with no behaviour change. */
  #passthrough(fallback: boolean): void {
    const started = this.#startedAt;
    const delegate = new this.#env.original();
    this.#delegate = delegate;

    try {
      delegate.open(this.#method, this.#url, true);
      delegate.responseType = this.#responseType;
      if (this.#timeout > 0) delegate.timeout = this.#timeout;
      delegate.withCredentials = this.#withCredentials;
      for (const [name, value] of this.#requestHeaders) {
        try {
          delegate.setRequestHeader(name, value);
        } catch {
          /* a forbidden header behaves the same on a real XHR */
        }
      }
      for (const type of HANDLER_EVENTS) {
        const handler = this.#handlers[type];
        if (handler !== null) {
          (delegate as unknown as Record<string, unknown>)[`on${type}`] = handler;
        }
      }
      for (const [type, listeners] of this.#listeners) {
        for (const listener of listeners) {
          delegate.addEventListener(type, listener as (event: Event) => void);
        }
      }

      const range = this.#requestHeader('Range');
      if (range !== null || isDiskMediaUrl(this.#url)) {
        delegate.addEventListener('loadend', () => {
          recordPassthroughRequest(delegate, this.#url, range, started, fallback);
        });
      }
    } catch (error) {
      // A synchronous throw means the request never left the browser.
      this.#failLog(error, 'xhr', fallback);
      this.#finish('error');
      return;
    }

    try {
      delegate.send(this.#body);
    } catch (error) {
      this.#failLog(error, 'xhr', fallback);
      this.#finish('error');
    }
  }
}

/** The original request is only read once it has finished. */
function recordPassthroughRequest(
  delegate: XMLHttpRequest,
  url: string,
  range: string | null,
  startedAt: number,
  fallback: boolean,
): void {
  let status: number | null = null;
  let contentRange: string | null = null;
  let byteLength: number | null = null;
  let allZero: boolean | null = null;
  try {
    status = delegate.status;
  } catch {
    /* requested too early: reported as unknown */
  }
  try {
    contentRange = delegate.getResponseHeader('Content-Range');
  } catch {
    /* header unreadable before completion */
  }
  try {
    const response = delegate.response;
    if (response instanceof ArrayBuffer) {
      const bytes = new Uint8Array(response);
      byteLength = bytes.byteLength;
      allZero = measureAllZero(bytes);
    } else if (typeof response === 'string') {
      byteLength = response.length;
    }
  } catch {
    /* `response` throws for an aborted request */
  }
  recordDiskRequest({
    at: Date.now(),
    url,
    range,
    status,
    contentRange,
    byteLength,
    durationMs: Math.round(nowMs() - startedAt),
    allZero,
    transport: 'xhr',
    fallback,
  });
}

/* --------------------------------------------------------------------------
 * Installation
 * ------------------------------------------------------------------------ */

/** Only `XMLHttpRequest` is touched; everything else stays the page's own. */
export interface XhrScope {
  XMLHttpRequest?: typeof XMLHttpRequest;
}

export interface RangeFetchTransportOptions {
  /** Defaults to `window`; injectable in tests. */
  readonly scope?: XhrScope;
  /** Injectable `fetch` (tests); `globalThis.fetch` at send time by default. */
  readonly fetchImpl?: typeof fetch;
  /** Defaults to `defaultShouldHandleUrl`. */
  readonly shouldHandleUrl?: ShouldHandleUrl;
}

interface Installation {
  readonly scope: XhrScope;
  readonly original: typeof XMLHttpRequest;
  readonly ctor: typeof XMLHttpRequest;
  readonly uninstall: () => void;
}

let installed: Installation | null = null;

function defaultScope(): XhrScope {
  if (typeof window !== 'undefined') return window as unknown as XhrScope;
  return globalThis as unknown as XhrScope;
}

function createTransportConstructor(env: TransportEnvironment): typeof XMLHttpRequest {
  function RangeFetchXMLHttpRequest(): RangeFetchRequest {
    return new RangeFetchRequest(env);
  }
  for (const key of ['UNSENT', 'OPENED', 'HEADERS_RECEIVED', 'LOADING', 'DONE'] as const) {
    Object.defineProperty(RangeFetchXMLHttpRequest, key, {
      value: READY_STATE[key],
      enumerable: true,
    });
  }
  Object.defineProperty(RangeFetchXMLHttpRequest, Symbol.hasInstance, {
    value: (value: unknown): boolean =>
      value instanceof RangeFetchRequest || value instanceof env.original,
  });
  return RangeFetchXMLHttpRequest as unknown as typeof XMLHttpRequest;
}

/**
 * Installs the transport once per page and returns an uninstall function.
 *
 * The installation is idempotent: a second call is a no-op returning the same
 * uninstall function, so a provider restarting a session never stacks wrappers.
 */
export function installRangeFetchTransport(options: RangeFetchTransportOptions = {}): () => void {
  installDiagnosticsGlobal();
  if (installed !== null) return installed.uninstall;

  const scope = options.scope ?? defaultScope();
  if (typeof scope.XMLHttpRequest !== 'function') {
    // Node, workers, jsdom without XHR: nothing to wrap, nothing to break.
    return () => undefined;
  }

  const original = scope.XMLHttpRequest;
  const env: TransportEnvironment = {
    original,
    shouldHandleUrl: options.shouldHandleUrl ?? defaultShouldHandleUrl,
    fetchImpl: options.fetchImpl,
  };
  const ctor = createTransportConstructor(env);

  const current: Installation = {
    scope,
    original,
    ctor,
    uninstall: () => {
      if (installed !== current) return;
      // Never clobber a constructor installed by someone else afterwards.
      if (scope.XMLHttpRequest === ctor) scope.XMLHttpRequest = original;
      installed = null;
    },
  };
  installed = current;
  scope.XMLHttpRequest = ctor;
  return current.uninstall;
}

/** `true` while the transport wraps `XMLHttpRequest` for this page. */
export function isRangeFetchTransportInstalled(): boolean {
  return installed !== null;
}
