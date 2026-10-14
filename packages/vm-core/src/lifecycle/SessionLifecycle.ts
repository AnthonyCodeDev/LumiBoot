import type { OSDefinition, SessionEvent, VMState } from '@lumiboot/contracts';
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
    #error: SessionError | undefined;
    #instance: VMInstance | null = null;
    #unsubscribe: (() => void) | null = null;
    #startPromise: Promise<void> | null = null;
    #startAbortController: AbortController | null = null;
    #starting = false;

    constructor(system: OSDefinition, registry: VMRegistry, id: string = createSessionId()) {
        this.system = system;
        this.#registry = registry;
        this.id = id;
    }

    get snapshot(): SessionSnapshot {
        return {
            id: this.id,
            systemId: this.system.id,
            providerId: this.#providerId,
            state: this.#machine.state,
            ...(this.#phase === undefined ? {} : { phase: this.#phase }),
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
        if (this.#instance !== null) return;
        if (this.#starting && this.#startPromise !== null) return this.#startPromise;
        const current = this.#machine.state;
        if (current !== 'idle' && current !== 'stopped' && current !== 'error') return;
        this.#starting = true;
        this.#error = undefined;
        this.#phase = undefined;
        if (current !== 'idle') this.#machine.transition('preparing');

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
                if (controller.signal.aborted) {
                    try {
                        await instance.dispose();
                    } catch {
                        /* nettoyage best-effort après annulation */
                    }
                    if (this.#machine.canTransition('stopped')) this.#machine.transition('stopped');
                    this.#emit();
                    return;
                }
                this.#instance = instance;
                this.#unsubscribe = instance.subscribe((event) => this.#onEvent(event));
            } catch (error) {
                if (controller.signal.aborted) {
                    if (this.#machine.canTransition('stopped')) this.#machine.transition('stopped');
                    this.#emit();
                    return;
                }
                const vmError: VMError = isVMError(error)
                    ? error
                    : new VMError('START_FAILED', 'Le démarrage a échoué.', { systemId: this.system.id });
                this.#fail(vmError.code, vmError.message);
            } finally {
                cleanupAbortRelay();
                this.#starting = false;
                this.#startAbortController = null;
                this.#startPromise = null;
            }
        })();

        await this.#startPromise;
    }

    async stop(): Promise<void> {
        if (this.#starting) {
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
        } catch {
            /* arrêt best-effort : ne pas masquer l'état final */
        }
        if (this.#machine.canTransition('stopped')) this.#machine.transition('stopped');
        this.#emit();
    }

    async dispose(): Promise<void> {
        this.#startAbortController?.abort();
        if (this.#startPromise !== null) await this.#startPromise.catch(() => undefined);
        if (this.#machine.state !== 'idle' && this.#machine.state !== 'stopped' && this.#machine.state !== 'error') {
            await this.stop();
        }
        this.#unsubscribe?.();
        this.#unsubscribe = null;
        try {
            await this.#instance?.dispose();
        } catch {
            /* libération best-effort */
        }
        this.#instance = null;
        this.#starting = false;
        this.#startAbortController = null;
        this.#startPromise = null;
        this.#phase = undefined;
        this.#listeners.clear();
    }

    #onEvent(event: SessionEvent): void {
        if (event.type === 'state') {
            if (this.#machine.canTransition(event.state)) this.#machine.transition(event.state);
            this.#emit();
            return;
        }
        if (event.type === 'progress') {
            this.#phase = event.phase;
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
