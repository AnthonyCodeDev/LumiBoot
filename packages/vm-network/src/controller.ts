import type { NetworkCapabilities } from './capabilities';
import { capabilitiesForMode } from './capabilities';
import type { NetworkErrorCode } from './errors';
import { NetworkError } from './errors';
import type { NetworkDiagnostics, NetworkStatus } from './diagnostics';
import type { NetworkProfile } from './profile';
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

class DefaultNetworkController implements NetworkController {
  readonly #profile: NetworkProfile;
  readonly #capabilities: NetworkCapabilities;
  readonly #now: () => number;
  readonly #listeners = new Set<(diagnostics: NetworkDiagnostics) => void>();

  #status: NetworkStatus = 'idle';
  #txBytes = 0;
  #rxBytes = 0;
  #lastError: { code: NetworkErrorCode; message: string } | undefined;
  #disposed = false;

  constructor(options: NetworkControllerOptions) {
    this.#profile = Object.freeze({
      mode: options.profile.mode,
      ...(options.profile.relayUrl === undefined ? {} : { relayUrl: options.profile.relayUrl }),
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
      txBytes: this.#txBytes,
      rxBytes: this.#rxBytes,
    };
    if (this.#lastError === undefined) return diagnostics;
    return { ...diagnostics, lastError: { ...this.#lastError } };
  }

  subscribe(listener: (diagnostics: NetworkDiagnostics) => void): () => void {
    if (this.#disposed) return () => undefined;
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.#disposed) {
      throw new NetworkError('NETWORK_CLEANUP_FAILED', 'Contrôleur réseau déjà libéré.');
    }
    if (signal?.aborted === true) {
      this.#fail('NETWORK_ABORTED', 'Démarrage du réseau annulé avant établissement.');
      throw new NetworkError('NETWORK_ABORTED', 'Démarrage du réseau annulé.');
    }

    this.#now();
    this.setStatus('starting');

    switch (this.#profile.mode) {
      case 'offline':
        this.setStatus('offline');
        return;
      case 'browser-fetch':
        this.setStatus('connected');
        return;
      case 'user-relay': {
        const validation = validateRelayUrl(this.#profile.relayUrl);
        if (!validation.ok || validation.url === undefined) {
          const message = validation.error ?? 'Adresse de relais invalide.';
          this.#fail('NETWORK_INVALID_RELAY_URL', message);
          throw new NetworkError('NETWORK_INVALID_RELAY_URL', message);
        }
        this.setStatus('connected');
        return;
      }
      case 'local-network': {
        const message = "Le mode « local-network » n'est pas encore implémenté.";
        this.#fail('NETWORK_UNSUPPORTED_MODE', message);
        throw new NetworkError('NETWORK_UNSUPPORTED_MODE', message);
      }
    }
  }

  async stop(): Promise<void> {
    try {
      this.#status = 'stopped';
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
    } catch (error) {
      this.#recordCleanupFailure(error);
    } finally {
      this.#disposed = true;
    }
  }

  reportTx(bytes: number): void {
    const next = accumulate(this.#txBytes, bytes);
    if (next === this.#txBytes) return;
    this.#txBytes = next;
    this.#notify();
  }

  reportRx(bytes: number): void {
    const next = accumulate(this.#rxBytes, bytes);
    if (next === this.#rxBytes) return;
    this.#rxBytes = next;
    this.#notify();
  }

  reportError(code: NetworkErrorCode, message: string): void {
    this.#fail(code, message);
  }

  setStatus(status: NetworkStatus): void {
    this.#status = status;
    this.#notify();
  }

  #fail(code: NetworkErrorCode, message: string): void {
    this.#lastError = { code, message: truncate(message, MAX_ERROR_MESSAGE_LENGTH) };
    this.#status = 'error';
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
        // Un auditeur défaillant ne doit jamais interrompre le contrôleur.
      }
    }
  }
}

export function createNetworkController(options: NetworkControllerOptions): NetworkController {
  return new DefaultNetworkController(options);
}
