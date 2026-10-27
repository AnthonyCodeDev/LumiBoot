import type { NetworkDiagnostics, OSDefinition, SessionEvent, VMState } from '@lumiboot/contracts';
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
 * Supervises start, stop and dispose; `running` is only reached on a real guest
 * proof and a fatal error actually releases the VM.
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
  // Neutralizes late engine events until the next `start()`.
  #halted = false;
  #cleanupPromise: Promise<void> | null = null;
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
    // A disposed session is terminal.
    if (this.#disposed) return;
    const current = this.#machine.state;
    if (this.#starting && this.#startPromise !== null) return this.#startPromise;
    if (this.#instance !== null) return;
    if (current !== 'idle' && current !== 'stopped' && current !== 'error') return;

    const startToken = ++this.#runToken;
    this.#starting = true;
    this.#halted = false;
    // New generation: a stale cleanup promise must not short-circuit this one.
    this.#cleanupPromise = null;
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
          this.#settleCancelledStart();
          return;
        }
        this.#instance = instance;
        const unsubscribe = instance.subscribe((event) => this.#onEvent(event));
        // A replayed `stopped` event may already have released the instance.
        if (this.#instance === instance) {
          this.#unsubscribe = unsubscribe;
        } else {
          unsubscribe();
        }
        if (controller.signal.aborted || startToken !== this.#runToken) {
          await this.#stopInstance();
          // An `error` replayed during `subscribe()` already started the cleanup.
          if (this.#cleanupPromise !== null) await this.#cleanupPromise;
          this.#settleCancelledStart();
          return;
        }
      } catch (error) {
        if (controller.signal.aborted || startToken !== this.#runToken) {
          this.#settleCancelledStart();
          return;
        }
        const vmError: VMError = isVMError(error)
          ? error
          : new VMError('START_FAILED', 'Startup failed.', { systemId: this.system.id });
        this.#fail(vmError.code, vmError.message);
        // Wait for the cleanup so the instance is never orphaned on return.
        await this.#cleanupPromise;
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
      this.#starting = false;
      this.#startAbortController = null;
      this.#startPromise = null;
    }
    const state = this.#machine.state;
    if (state === 'idle' || state === 'stopped' || state === 'error') {
      // Wait for a cleanup already started, so no release stays in flight.
      if (this.#cleanupPromise !== null) await this.#cleanupPromise;
      return;
    }
    if (this.#machine.canTransition('stopping')) {
      this.#machine.transition('stopping');
      this.#emit();
    }
    await this.#releaseResources('stop');
    if (this.#machine.canTransition('stopped')) this.#machine.transition('stopped');
    // Terminal: a late engine event must not resurrect the session.
    this.#halted = true;
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
      if (this.#machine.canTransition('stopping')) {
        this.#machine.transition('stopping');
        this.#emit();
      }
    }
    await this.#releaseResources('dispose');
    if (this.#machine.canTransition('stopped')) this.#machine.transition('stopped');
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
    // Late events after disposal or a terminal stop have no effect.
    if (this.#disposed || this.#halted) return;
    if (event.type === 'state') {
      // `stopped` means a spontaneous stop that must traverse `stopping`.
      if (event.state === 'stopped') {
        this.#reconcileSpontaneousStop();
      } else {
        this.#applyState(event.state);
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
      // Purely observable: no state transition, no session failure.
      this.#network = event.network;
      this.#emit();
      return;
    }
    this.#fail(event.code, event.message);
  }

  /**
   * `running` without an explicit `booting` traverses `booting` to respect the
   * state machine invariant.
   */
  #applyState(state: VMState): void {
    if (this.#machine.canTransition(state)) {
      this.#machine.transition(state);
    } else if (state === 'running' && this.#machine.canTransition('booting')) {
      this.#machine.transition('booting');
      this.#machine.transition('running');
    }
  }

  /**
   * The direct `running -> stopped` transition does not exist, so the stop
   * traverses `stopping` and releases the resources.
   */
  #reconcileSpontaneousStop(): void {
    const state = this.#machine.state;
    if (state === 'stopped' || state === 'idle' || state === 'error') return;
    this.#halted = true;
    if (this.#machine.canTransition('stopping')) {
      this.#machine.transition('stopping');
    }
    void this.#releaseResources('stop');
    if (this.#machine.canTransition('stopped')) {
      this.#machine.transition('stopped');
    }
    this.#phase = undefined;
    this.#loadedBytes = undefined;
    this.#totalBytes = undefined;
    this.#network = undefined;
  }

  #fail(code: string, message: string): void {
    this.#error = { code, message };
    if (this.#machine.canTransition('error')) this.#machine.transition('error');
    // Invalidates any start in flight.
    this.#invalidateStart();
    this.#emit();
    // Not awaited here: `#onEvent` is synchronous, the promise stays observable.
    void this.#releaseResources('error');
  }

  /**
   * Concurrent operations share one effective cleanup; the promise never
   * rejects, failures go to `onCleanupError`.
   */
  #releaseResources(context: string): Promise<void> {
    if (this.#cleanupPromise !== null) return this.#cleanupPromise;

    const instance = this.#instance;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    // The reference is cut first: no orphaned instance if cleanup fails later.
    this.#instance = null;

    const cleanup = (async () => {
      if (!instance) return;
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
    })().catch((error) => {
      // Safety belt: no unhandled exception if the supervision itself fails.
      this.#reportCleanupError(error, context);
    });

    this.#cleanupPromise = cleanup;
    return cleanup;
  }

  #settleCancelledStart(): void {
    if (this.#machine.canTransition('stopping')) this.#machine.transition('stopping');
    if (this.#machine.canTransition('stopped')) this.#machine.transition('stopped');
    // A cancelled start is terminal: late events are neutralized.
    this.#halted = true;
    this.#phase = undefined;
    this.#loadedBytes = undefined;
    this.#totalBytes = undefined;
    this.#network = undefined;
    this.#emit();
  }

  #invalidateStart(): void {
    ++this.#runToken;
    this.#startAbortController?.abort();
    this.#starting = false;
    this.#startAbortController = null;
    this.#startPromise = null;
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
      console.warn(`[SessionLifecycle ${this.id}] cleanup failed (${context}).`, error);
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
