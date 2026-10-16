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
 * Supervise le cycle de vie d'une session : démarrage, arrêt, destruction.
 *
 * Garanties :
 * - aucun double démarrage concurrent ;
 * - transitions d'état validées par la machine à états ;
 * - `dispose()` libère toujours les ressources, même après un échec partiel ;
 * - `running` n'est atteint que sur preuve d'un démarrage réel du système ;
 * - une erreur fatale (téléchargement, `run()` du moteur, événement `error`
 *   d'un moteur) libère réellement la VM, au-delà du seul passage à `error`.
 *
 * Le nettoyage est supervisé et idempotent : une seule libération effective est
 * partagée par toutes les opérations concurrentes (`start`/`stop`/`dispose`),
 * les échecs de nettoyage restent observables, et aucune exception n'est
 * jamais laissée non gérée.
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
  // Arrêt terminal réconcilié (arrêt spontané du moteur) : neutralise tout
  // événement tardif du moteur jusqu'au prochain `start()`.
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
    // Une session détruite est terminale : aucune réactivation silencieuse.
    if (this.#disposed) return;
    const current = this.#machine.state;
    if (this.#starting && this.#startPromise !== null) return this.#startPromise;
    if (this.#instance !== null) return;
    if (current !== 'idle' && current !== 'stopped' && current !== 'error') return;

    const startToken = ++this.#runToken;
    this.#starting = true;
    this.#halted = false;
    // Nouvelle génération : la précédente (éventuellement déjà nettoyée) ne
    // doit pas court-circuiter la libération de la nouvelle instance.
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
        // Un arrêt spontané survenu PENDANT l'abonnement (rejeu d'événements
        // mémorisés) a déjà libéré l'instance : on neutralise alors le
        // désabonnement au lieu de le conserver sur une référence morte.
        if (this.#instance === instance) {
          this.#unsubscribe = unsubscribe;
        } else {
          unsubscribe();
        }
        if (controller.signal.aborted || startToken !== this.#runToken) {
          await this.#stopInstance();
          // Un événement `error` reçu pendant `subscribe()` a déjà lancé le
          // nettoyage supervisé : on l'attend pour ne jamais résoudre `start()`
          // avec une instance encore vivante.
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
          : new VMError('START_FAILED', 'Le démarrage a échoué.', { systemId: this.system.id });
        this.#fail(vmError.code, vmError.message);
        // L'échec libère réellement la VM : on attend le nettoyage supervisé
        // avant de résoudre `start()`, pour que l'instance ne soit jamais
        // orpheline au moment où l'appelant reprend la main.
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
      // Un arrêt spontané a pu lancer un nettoyage : on l'attend pour ne jamais
      // rendre la main avec une libération encore en vol.
      if (this.#cleanupPromise !== null) await this.#cleanupPromise;
      return;
    }
    if (this.#machine.canTransition('stopping')) {
      this.#machine.transition('stopping');
      this.#emit();
    }
    // Libération idempotente et supervisée : la même promesse est partagée avec
    // un `dispose()`/`#fail()` concurrent, donc une seule libération effective.
    await this.#releaseResources('stop');
    if (this.#machine.canTransition('stopped')) this.#machine.transition('stopped');
    // Terminal : un événement tardif d'un moteur fautif ne doit pas ressusciter
    // la session (un `start()` ultérieur réarme `#halted`).
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
    // Un événement tardif après destruction, ou après un arrêt terminal
    // (arrêt spontané réconcilié / arrêt volontaire) n'a aucun effet observable.
    if (this.#disposed || this.#halted) return;
    if (event.type === 'state') {
      // `stopped` est traité à part : c'est le signal d'un arrêt SPONTANÉ
      // (extinction/crash de l'invité) qui doit traverser `stopping`, libérer
      // réellement les ressources puis atteindre `stopped` — jamais être ignoré.
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
      // Les diagnostics réseau sont purement observables : ils rafraîchissent
      // le snapshot sans provoquer ni transition d'état ni échec de session.
      this.#network = event.network;
      this.#emit();
      return;
    }
    this.#fail(event.code, event.message);
  }

  /**
   * Applique une transition d'état ordinaire émise par le moteur. `running`
   * prouvé sans phase `booting` explicite traverse `booting` pour respecter
   * l'invariant de la machine à états.
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
   * Réconcilie un arrêt spontané (`stopped` émis par le moteur sans passer par
   * `stop()`), y compris depuis `running` ou `booting`.
   *
   * La transition directe `running -> stopped` n'existe pas : on traverse
   * `stopping`, on libère réellement les ressources de façon supervisée et
   * idempotente (`#releaseResources` coupe immédiatement la référence à
   * l'instance puis nettoie), puis on atteint `stopped`. Aucune VM zombie,
   * aucun redémarrage bloqué ; un échec de `destroy()` sous-jacent est rapporté
   * via `onCleanupError`. `#halted` neutralise ensuite tout événement tardif.
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
    // Invalide tout démarrage en vol : la session est terminale côté exécution.
    this.#invalidateStart();
    this.#emit();
    // Nettoyage supervisé : libère réellement la VM (et nettoie la référence à
    // l'instance). On n'attend pas ici — `#onEvent` est synchrone — mais la
    // promesse partagée reste observable via `dispose()` et via l'attente
    // explicite faite dans `start()`.
    void this.#releaseResources('error');
  }

  /**
   * Libération supervisée et idempotente des ressources de l'instance courante.
   *
   * Toutes les opérations concurrentes partagent la même promesse : `stop()`,
   * `dispose()` et `#fail()` ne déclenchent qu'un seul nettoyage effectif. La
   * promesse ne rejette jamais ; les échecs sont rapportés via le callback
   * `onCleanupError` (et `console.warn`).
   */
  #releaseResources(context: string): Promise<void> {
    if (this.#cleanupPromise !== null) return this.#cleanupPromise;

    const instance = this.#instance;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    // La référence est coupée immédiatement : jamais d'instance orpheline,
    // même si le nettoyage asynchrone échoue plus tard.
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
      // Ceinture de sécurité : aucune exception non gérée, même si la
      // supervision elle-même échoue.
      this.#reportCleanupError(error, context);
    });

    this.#cleanupPromise = cleanup;
    return cleanup;
  }

  #settleCancelledStart(): void {
    if (this.#machine.canTransition('stopping')) this.#machine.transition('stopping');
    if (this.#machine.canTransition('stopped')) this.#machine.transition('stopped');
    // Un démarrage annulé est terminal : tout événement tardif de l'instance
    // supplantée est neutralisé jusqu'au prochain `start()`.
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
