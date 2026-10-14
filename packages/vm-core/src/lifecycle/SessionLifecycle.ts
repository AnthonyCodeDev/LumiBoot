import type {
  NetworkDiagnostics,
  OSDefinition,
  SessionEvent,
  VMState,
} from '@lumiboot/contracts';
import { VMError, isVMError } from '../errors/VMError';
import { createSessionId } from '../ids';
import { SessionStateMachine } from './SessionStateMachine';
import type { VMRegistry } from '../registry/VMRegistry';
import type { VMConfiguration } from '../contracts/VMConfiguration';
import type { VMInstance } from '../contracts/VMInstance';

export interface SessionError {
  code: string;
  message: string;
}

export interface SessionSnapshot {
  id: string;
  systemId: string;
  providerId: string;
  state: VMState;
  phase?: string;
  loadedBytes?: number;
  totalBytes?: number;
  network?: NetworkDiagnostics;
  error?: SessionError;
}

export type SessionListener = (snapshot: SessionSnapshot) => void;

/**
 * Supervise le cycle de vie d'une session : démarrage, arrêt, destruction.
 *
 * Garanties :
 * - aucun double démarrage concurrent ;
 * - transitions d'état validées par la machine à états ;
 * - `dispose()` libère toujours les ressources, même après un échec partiel ;
 * - `running` n'est atteint que sur preuve d'un démarrage réel du système.
 */
export class SessionLifecycle {
  readonly id: string;
  readonly system: OSDefinition;
  readonly #registry: VMRegistry;
  readonly #machine = new SessionStateMachine();
  readonly #listeners = new Set<SessionListener>();
  #providerId = 'pending';
  #phase: string | undefined;
  #loadedBytes: number | undefined;
  #totalBytes: number | undefined;
  #network: NetworkDiagnostics | undefined;
  #error: SessionError | undefined;
  #instance: VMInstance | null = null;
  #unsubscribe: (() => void) | null = null;
  #startPromise: Promise<void> | null = null;
  #startAbortController: AbortController | null = null;
  #starting = false;
  #runToken = 0;
  #disposed = false;
  readonly #onCleanupError: ((error: unknown, context: string) => void) | undefined;

  constructor(
    system: OSDefinition,
    registry: VMRegistry,
    id: string = createSessionId(),
    onCleanupError?: (error: unknown, context: string) => void,
  ) {
    this.system = system;
    this.#registry = registry;
    this.id = id;
    this.#onCleanupError = onCleanupError;
  }

  get snapshot(): SessionSnapshot {
    return {
      id: this.id,
      systemId: this.system.id,
      providerId: this.#providerId,
      state: this.#machine.state,
      ...(this.#phase === undefined ? {} : { phase: this.#phase }),
      ...(this.#loadedBytes === undefined ? {} : { loadedBytes: this.#loadedBytes }),
      ...(this.#totalBytes === undefined ? {} : { totalBytes: this.#totalBytes }),
      ...(this.#network === undefined ? {} : { network: this.#network }),
      ...(this.#error === undefined ? {} : { error: this.#error }),
    };
  }

  subscribe(listener: SessionListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async start(mountTarget: unknown, configuration?: VMConfiguration): Promise<void> {
    // Une session détruite est terminale : aucune réactivation silencieuse.
    if (this.#disposed) return;
    const current = this.#machine.state;
    if (this.#starting && this.#startPromise !== null) return this.#startPromise;
    if (this.#instance !== null) return;
    if (current !== 'idle' && current !== 'stopped' && current !== 'error') return;

    const startToken = ++this.#runToken;
    this.#starting = true;
    this.#error = undefined;
    this.#phase = undefined;
    this.#loadedBytes = undefined;
    this.#totalBytes = undefined;
    this.#network = undefined;
    this.#machine.transition('preparing');
    this.#emit();

    const engine = this.#registry.resolve(this.system);
    this.#providerId = engine.id;
    this.#emit();

    const controller = new AbortController();
    this.#startAbortController = controller;
    const cleanupAbortRelay = this.#wireAbortSignal(configuration?.signal, controller);
    const mergedConfiguration = this.#mergeConfiguration(configuration, controller.signal);

    this.#startPromise = (async () => {
      try {
        const instance = await engine.start(this.system, mountTarget, mergedConfiguration);
        if (controller.signal.aborted || startToken !== this.#runToken) {
          await this.#disposeInstance(instance);
          if (this.#machine.canTransition('stopping')) this.#machine.transition('stopping');
          if (this.#machine.canTransition('stopped')) this.#machine.transition('stopped');
          this.#phase = undefined;
          this.#loadedBytes = undefined;
          this.#totalBytes = undefined;
          this.#network = undefined;
          this.#emit();
          return;
        }
        this.#instance = instance;
        this.#unsubscribe = instance.subscribe((event) => this.#onEvent(event));
        if (controller.signal.aborted || startToken !== this.#runToken) {
          await this.#stopInstance();
          if (this.#machine.canTransition('stopping')) this.#machine.transition('stopping');
          if (this.#machine.canTransition('stopped')) this.#machine.transition('stopped');
          this.#phase = undefined;
          this.#loadedBytes = undefined;
          this.#totalBytes = undefined;
          this.#network = undefined;
          this.#emit();
          return;
        }
      } catch (error) {
        if (controller.signal.aborted || startToken !== this.#runToken) {
          if (this.#machine.canTransition('stopping')) this.#machine.transition('stopping');
          if (this.#machine.canTransition('stopped')) this.#machine.transition('stopped');
          this.#phase = undefined;
          this.#loadedBytes = undefined;
          this.#totalBytes = undefined;
          this.#network = undefined;
          this.#emit();
          return;
        }
        const vmError: VMError = isVMError(error)
          ? error
          : new VMError('START_FAILED', 'Le démarrage a échoué.', { systemId: this.system.id });
        this.#fail(vmError.code, vmError.message);
      } finally {
        cleanupAbortRelay();
        if (this.#runToken === startToken) {
          this.#starting = false;
          this.#startAbortController = null;
          this.#startPromise = null;
        }
      }
    })();

    await this.#startPromise;
  }

  async stop(): Promise<void> {
    if (this.#starting) {
      ++this.#runToken;
      this.#startAbortController?.abort();
      if (this.#startPromise !== null) await this.#startPromise.catch(() => undefined);
    }
    const state = this.#machine.state;
    if (state === 'idle' || state === 'stopped' || state === 'error') return;
    if (this.#machine.canTransition('stopping')) {
      this.#machine.transition('stopping');
      this.#emit();
    }
    try {
      await this.#instance?.stop();
    } catch (error) {
      // Arrêt best-effort : on n'interrompt pas la transition, mais l'échec
      // doit rester observable (dev + tests) plutôt que d'être avalé.
      this.#reportCleanupError(error, 'stop');
    }
    await this.#stopInstance();
    if (this.#machine.canTransition('stopped')) this.#machine.transition('stopped');
    this.#phase = undefined;
    this.#loadedBytes = undefined;
    this.#totalBytes = undefined;
    this.#network = undefined;
    this.#emit();
  }

  async dispose(): Promise<void> {
    ++this.#runToken;
    this.#startAbortController?.abort();
    if (this.#startPromise !== null) await this.#startPromise.catch(() => undefined);
    if (
      this.#machine.state !== 'idle' &&
      this.#machine.state !== 'stopped' &&
      this.#machine.state !== 'error'
    ) {
      await this.stop();
    }
    await this.#stopInstance();
    this.#providerId = 'unavailable';
    this.#starting = false;
    this.#startAbortController = null;
    this.#startPromise = null;
    this.#phase = undefined;
    this.#loadedBytes = undefined;
    this.#totalBytes = undefined;
    this.#network = undefined;
    this.#disposed = true;
    this.#listeners.clear();
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  #onEvent(event: SessionEvent): void {
    if (event.type === 'state') {
      if (this.#machine.canTransition(event.state)) {
        this.#machine.transition(event.state);
      } else if (event.state === 'running' && this.#machine.canTransition('booting')) {
        // Preuve de démarrage reçue sans phase « booting » explicite : on
        // traverse `booting` pour respecter l'invariant de la machine à états
        // tout en honorant la preuve réelle (`running`).
        this.#machine.transition('booting');
        this.#machine.transition('running');
      }
      this.#emit();
      return;
    }
    if (event.type === 'progress') {
      if (
        (event.phase === 'booting' || event.phase === 'downloading') &&
        this.#machine.canTransition(event.phase)
      ) {
        this.#machine.transition(event.phase);
      }
      this.#phase = event.phase;
      if (event.loadedBytes === undefined) {
        this.#loadedBytes = undefined;
      } else {
        this.#loadedBytes = event.loadedBytes;
      }
      if (event.totalBytes === undefined) {
        this.#totalBytes = undefined;
      } else {
        this.#totalBytes = event.totalBytes;
      }
      this.#emit();
      return;
    }
    if (event.type === 'network') {
      // Les diagnostics réseau sont purement observables : ils rafraîchissent
      // le snapshot sans provoquer ni transition d'état ni échec de session.
      this.#network = event.network;
      this.#emit();
      return;
    }
    this.#fail(event.code, event.message);
  }

  #fail(code: string, message: string): void {
    this.#error = { code, message };
    if (this.#machine.canTransition('error')) this.#machine.transition('error');
    this.#emit();
  }

  async #stopInstance(): Promise<void> {
    const instance = this.#instance;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#instance = null;
    if (!instance) return;
    try {
      await instance.dispose();
    } catch (error) {
      this.#reportCleanupError(error, 'dispose');
    }
  }

  async #disposeInstance(instance: VMInstance): Promise<void> {
    try {
      await instance.stop();
    } catch (error) {
      this.#reportCleanupError(error, 'stop');
    }
    try {
      await instance.dispose();
    } catch (error) {
      this.#reportCleanupError(error, 'dispose');
    }
  }

  #reportCleanupError(error: unknown, context: string): void {
    this.#onCleanupError?.(error, context);
    if (typeof console !== 'undefined') {
      console.warn(`[SessionLifecycle ${this.id}] échec de nettoyage (${context}).`, error);
    }
  }

  #mergeConfiguration(
    configuration: VMConfiguration | undefined,
    signal: AbortSignal,
  ): VMConfiguration | undefined {
    if (configuration === undefined) return { signal };
    return { ...configuration, signal };
  }

  #wireAbortSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
    if (!signal) return () => undefined;
    if (signal.aborted) {
      controller.abort(signal.reason);
      return () => undefined;
    }
    const relay = (): void => controller.abort(signal.reason);
    signal.addEventListener('abort', relay, { once: true });
    return () => signal.removeEventListener('abort', relay);
  }

  #emit(): void {
    const snapshot = this.snapshot;
    for (const listener of this.#listeners) listener(snapshot);
  }
}
