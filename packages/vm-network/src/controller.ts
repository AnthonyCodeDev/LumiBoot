import type { NetworkCapabilities, NetworkTransportKind } from './capabilities';
import { capabilitiesForMode } from './capabilities';
import type { NetworkErrorCode } from './errors';
import { NetworkError } from './errors';
import type {
  NetworkDiagnostics,
  NetworkProbeKind,
  NetworkProbeResult,
  NetworkStatus,
} from './diagnostics';
import type { NetworkMode } from './modes';
import type { NetworkProfile } from './profile';
import { DEFAULT_PROXY_URL, validateProxyUrl } from './proxy';
import { validateRelayUrl } from './relay';

const MAX_COUNTER = Number.MAX_SAFE_INTEGER;
const MAX_ERROR_MESSAGE_LENGTH = 300;

export interface NetworkControllerOptions {
  profile: NetworkProfile;
  now?: () => number;
}

export interface NetworkController {
  readonly profile: NetworkProfile;
  readonly capabilities: NetworkCapabilities;
  snapshot(): NetworkDiagnostics;
  subscribe(listener: (diagnostics: NetworkDiagnostics) => void): () => void;
  start(signal?: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
  reportTx(bytes: number): void;
  reportRx(bytes: number): void;
  reportError(code: NetworkErrorCode, message: string): void;
  setStatus(status: NetworkStatus): void;
  recordProbe(kind: NetworkProbeKind, result: NetworkProbeResult): void;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function accumulate(current: number, delta: number): number {
  if (!Number.isFinite(delta) || delta < 0) return current;
  const total = current + delta;
  if (!Number.isFinite(total)) return MAX_COUNTER;
  return Math.min(total, MAX_COUNTER);
}

/** Transport backend associated with a mode, purely descriptive. */
function transportForMode(mode: NetworkMode): NetworkTransportKind {
  switch (mode) {
    case 'browser-fetch':
      return 'fetch';
    case 'local-proxy':
    case 'user-relay':
      return 'wisp';
    case 'offline':
    case 'local-network':
      return 'none';
  }
}

class DefaultNetworkController implements NetworkController {
  readonly #profile: NetworkProfile;
  readonly #capabilities: NetworkCapabilities;
  readonly #now: () => number;
  readonly #listeners = new Set<(diagnostics: NetworkDiagnostics) => void>();

  #status: NetworkStatus = 'idle';
  #verified = false;
  #txBytes = 0;
  #rxBytes = 0;
  #lastError: { code: NetworkErrorCode; message: string } | undefined;
  #probes: Partial<Record<NetworkProbeKind, NetworkProbeResult>> = {};
  #disposed = false;

  constructor(options: NetworkControllerOptions) {
    this.#profile = Object.freeze({
      mode: options.profile.mode,
      ...(options.profile.relayUrl === undefined ? {} : { relayUrl: options.profile.relayUrl }),
      ...(options.profile.proxyUrl === undefined ? {} : { proxyUrl: options.profile.proxyUrl }),
      ...(options.profile.proxyToken === undefined
        ? {}
        : { proxyToken: options.profile.proxyToken }),
    });
    this.#capabilities = capabilitiesForMode(options.profile.mode);
    this.#now = options.now ?? (() => Date.now());
  }

  get profile(): NetworkProfile {
    return this.#profile;
  }

  get capabilities(): NetworkCapabilities {
    return this.#capabilities;
  }

  snapshot(): NetworkDiagnostics {
    const diagnostics: NetworkDiagnostics = {
      mode: this.#profile.mode,
      status: this.#status,
      transport: transportForMode(this.#profile.mode),
      verified: this.#verified,
      txBytes: this.#txBytes,
      rxBytes: this.#rxBytes,
    };
    const withProbes =
      Object.keys(this.#probes).length === 0
        ? diagnostics
        : { ...diagnostics, probes: { ...this.#probes } };
    if (this.#lastError === undefined) return withProbes;
    return { ...withProbes, lastError: { ...this.#lastError } };
  }

  subscribe(listener: (diagnostics: NetworkDiagnostics) => void): () => void {
    if (this.#disposed) return () => undefined;
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Accepts the configuration and, at best, **configures** the transport.
   *
   * A mode with a transport (browser-fetch, user-relay, local-proxy) ends up in
   * `configured`: the profile is accepted but **nothing proves the connection is
   * established**. Only the provider can move the state to `connected`/`online`
   * through `setStatus`, once the transport is really operational.
   */
  async start(signal?: AbortSignal): Promise<void> {
    if (this.#disposed) return;
    if (signal?.aborted === true) {
      this.#fail('NETWORK_ABORTED', 'Network start aborted before it was established.');
      throw new NetworkError('NETWORK_ABORTED', 'Network start aborted.');
    }

    this.#now();

    switch (this.#profile.mode) {
      case 'offline':
        this.setStatus('offline');
        return;
      case 'browser-fetch':
        this.setStatus('configured');
        return;
      case 'user-relay': {
        const validation = validateRelayUrl(this.#profile.relayUrl);
        if (!validation.ok || validation.url === undefined) {
          const message = validation.error ?? 'Invalid relay address.';
          this.#fail('NETWORK_INVALID_RELAY_URL', message);
          throw new NetworkError('NETWORK_INVALID_RELAY_URL', message);
        }
        this.setStatus('configured');
        return;
      }
      case 'local-proxy': {
        const validation = validateProxyUrl(this.#profile.proxyUrl ?? DEFAULT_PROXY_URL);
        if (!validation.ok || validation.url === undefined) {
          const message = validation.error ?? 'Invalid local network proxy address.';
          this.#fail('NETWORK_INVALID_PROXY_URL', message);
          throw new NetworkError('NETWORK_INVALID_PROXY_URL', message);
        }
        this.setStatus('configured');
        return;
      }
      case 'local-network': {
        const message = 'The "local-network" mode is not implemented.';
        this.#fail('NETWORK_UNSUPPORTED_MODE', message);
        throw new NetworkError('NETWORK_UNSUPPORTED_MODE', message);
      }
    }
  }

  async stop(): Promise<void> {
    if (this.#disposed) return;
    try {
      this.#status = 'stopped';
      this.#verified = false;
      this.#notify();
    } catch (error) {
      this.#recordCleanupFailure(error);
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    try {
      this.#listeners.clear();
      this.#status = 'stopped';
      this.#verified = false;
    } catch (error) {
      this.#recordCleanupFailure(error);
    } finally {
      this.#disposed = true;
    }
  }

  reportTx(bytes: number): void {
    if (this.#disposed) return;
    const next = accumulate(this.#txBytes, bytes);
    if (next === this.#txBytes) return;
    this.#txBytes = next;
    this.#notify();
  }

  reportRx(bytes: number): void {
    if (this.#disposed) return;
    const next = accumulate(this.#rxBytes, bytes);
    if (next === this.#rxBytes) return;
    this.#rxBytes = next;
    this.#notify();
  }

  reportError(code: NetworkErrorCode, message: string): void {
    if (this.#disposed) return;
    this.#fail(code, message);
  }

  setStatus(status: NetworkStatus): void {
    if (this.#disposed) return;
    this.#status = status;
    this.#recomputeVerified();
    this.#notify();
  }

  /**
   * Records the result of a **real probe** supplied by the provider.
   * `verified` is **recomputed**: it only becomes true if a `tcp` or `https`
   * probe is `ok`, never from the mode. Silent no-op after `dispose`.
   */
  recordProbe(kind: NetworkProbeKind, result: NetworkProbeResult): void {
    if (this.#disposed) return;
    const stored: NetworkProbeResult = {
      ok: result.ok,
      at: result.at,
      ...(result.detail === undefined ? {} : { detail: result.detail }),
    };
    this.#probes = { ...this.#probes, [kind]: stored };
    this.#recomputeVerified();
    this.#notify();
  }

  /**
   * `verified` reflects a **real proof**: only a successful `tcp` or `https`
   * probe. `dns`/`http` and the mode itself are not enough.
   */
  #recomputeVerified(): void {
    const tcp = this.#probes.tcp;
    const https = this.#probes.https;
    this.#verified = tcp?.ok === true || https?.ok === true;
  }

  #fail(code: NetworkErrorCode, message: string): void {
    this.#lastError = { code, message: truncate(message, MAX_ERROR_MESSAGE_LENGTH) };
    this.#status = 'error';
    this.#verified = false;
    this.#notify();
  }

  #recordCleanupFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.#lastError = {
      code: 'NETWORK_CLEANUP_FAILED',
      message: truncate(message, MAX_ERROR_MESSAGE_LENGTH),
    };
    this.#notify();
  }

  #notify(): void {
    if (this.#listeners.size === 0) return;
    const diagnostics = this.snapshot();
    for (const listener of Array.from(this.#listeners)) {
      try {
        listener(diagnostics);
      } catch {
        // A failing listener must never interrupt the controller.
      }
    }
  }
}

export function createNetworkController(options: NetworkControllerOptions): NetworkController {
  return new DefaultNetworkController(options);
}
