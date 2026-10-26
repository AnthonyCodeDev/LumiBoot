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
 * Supervises the lifecycle of a session: start, stop, destroy.
 *
 * Guarantees:
 * - no concurrent double start;
 * - state transitions validated by the state machine;
 * - `dispose()` always releases resources, even after a partial failure;
 * - `running` is only reached on proof of a real system start;
 * - a fatal error (download, engine `run()`, `error` event from an engine)
 *   actually releases the VM, beyond the sole switch to `error`.
 *
 * Cleanup is supervised and idempotent: a single effective release is shared by
 * all concurrent operations (`start`/`stop`/`dispose`), cleanup failures stay
 * observable, and no exception is ever left unhandled.
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
  // Reconciled terminal stop (spontaneous engine stop): neutralizes any late
  // engine event until the next `start()`.
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
    // A disposed session is terminal: no silent reactivation.
    if (this.#disposed) return;
    const current = this.#machine.state;
    if (this.#starting && this.#startPromise !== null) return this.#startPromise;
    if (this.#instance !== null) return;
    if (current !== 'idle' && current !== 'stopped' && current !== 'error') return;

    const startToken = ++this.#runToken;
    this.#starting = true;
    this.#halted = false;
    // New generation: the previous one (possibly already cleaned up) must not
    // short-circuit the release of the new instance.
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
        // A spontaneous stop that occurred DURING subscription (replay of
        // memorized events) already released the instance: the unsubscribe is
        // then neutralized instead of kept on a dead reference.
        if (this.#instance === instance) {
          this.#unsubscribe = unsubscribe;
        } else {
          unsubscribe();
        }
        if (controller.signal.aborted || startToken !== this.#runToken) {
          await this.#stopInstance();
          // An `error` event received during `subscribe()` already started the
          // supervised cleanup: wait for it so `start()` never resolves with a
          // still-living instance.
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
        // The failure actually releases the VM: wait for the supervised cleanup
        // before resolving `start()`, so the instance is never orphaned when the
        // caller gets control back.
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
      // A spontaneous stop may have started a cleanup: wait for it so we never
      // return with a release still in flight.
      if (this.#cleanupPromise !== null) await this.#cleanupPromise;
      return;
    }
    if (this.#machine.canTransition('stopping')) {
      this.#machine.transition('stopping');
      this.#emit();
    }
    // Idempotent, supervised release: the same promise is shared with a
    // concurrent `dispose()`/`#fail()`, so a single effective release.
    await this.#releaseResources('stop');
    if (this.#machine.canTransition('stopped')) this.#machine.transition('stopped');
    // Terminal: a late event from a faulty engine must not resurrect the
    // session (a later `start()` re-arms `#halted`).
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
    // A late event after disposal, or after a terminal stop (reconciled
    // spontaneous stop / deliberate stop) has no observable effect.
    if (this.#disposed || this.#halted) return;
    if (event.type === 'state') {
      // `stopped` is handled separately: it is the signal of a SPONTANEOUS stop
      // (guest shutdown/crash) that must traverse `stopping`, actually release
      // the resources and then reach `stopped` — never be ignored.
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
      // Network diagnostics are purely observable: they refresh the snapshot
      // without triggering any state transition or session failure.
      this.#network = event.network;
      this.#emit();
      return;
    }
    this.#fail(event.code, event.message);
  }

  /**
   * Applies an ordinary state transition emitted by the engine. `running`
   * proven without an explicit `booting` phase traverses `booting` to respect
   * the state machine invariant.
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
   * Reconciles a spontaneous stop (`stopped` emitted by the engine without
   * going through `stop()`), including from `running` or `booting`.
   *
   * The direct `running -> stopped` transition does not exist: we traverse
   * `stopping`, actually release the resources in a supervised and idempotent
   * way (`#releaseResources` immediately cuts the instance reference then
   * cleans up), then reach `stopped`. No zombie VM, no blocked restart; an
   * underlying `destroy()` failure is reported via `onCleanupError`. `#halted`
   * then neutralizes any late event.
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
    // Invalidates any start in flight: the session is terminal on the execution
    // side.
    this.#invalidateStart();
    this.#emit();
    // Supervised cleanup: actually releases the VM (and clears the instance
    // reference). We do not wait here — `#onEvent` is synchronous — but the
    // shared promise stays observable via `dispose()` and via the explicit wait
    // performed in `start()`.
    void this.#releaseResources('error');
  }

  /**
   * Supervised, idempotent release of the current instance resources.
   *
   * All concurrent operations share the same promise: `stop()`, `dispose()` and
   * `#fail()` only trigger one effective cleanup. The promise never rejects;
   * failures are reported via the `onCleanupError` callback (and
   * `console.warn`).
   */
  #releaseResources(context: string): Promise<void> {
    if (this.#cleanupPromise !== null) return this.#cleanupPromise;

    const instance = this.#instance;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    // The reference is cut immediately: never an orphaned instance, even if the
    // asynchronous cleanup fails later.
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
      // Safety belt: no unhandled exception, even if the supervision itself
      // fails.
      this.#reportCleanupError(error, context);
    });

    this.#cleanupPromise = cleanup;
    return cleanup;
  }

  #settleCancelledStart(): void {
    if (this.#machine.canTransition('stopping')) this.#machine.transition('stopping');
    if (this.#machine.canTransition('stopped')) this.#machine.transition('stopped');
    // A cancelled start is terminal: any late event from the superseded
    // instance is neutralized until the next `start()`.
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
