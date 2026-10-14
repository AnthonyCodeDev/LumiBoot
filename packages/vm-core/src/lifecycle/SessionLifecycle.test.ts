import { describe, expect, it, vi } from 'vitest';
import type { OSDefinition, SessionEvent, VMState } from '@lumiboot/contracts';
import { SessionLifecycle } from './SessionLifecycle';
import type { SessionSnapshot } from './SessionLifecycle';
import type { VMEngine } from '../contracts/VMEngine';
import type { VMInstance } from '../contracts/VMInstance';
import { NO_CAPABILITIES, type VMCapabilities } from '../contracts/VMCapabilities';
import { VMRegistry } from '../registry/VMRegistry';

function makeOS(overrides: Partial<OSDefinition> = {}): OSDefinition {
  return {
    id: 'debian-12-i386',
    slug: 'debian-12-i386',
    family: 'linux',
    displayName: 'Debian',
    versionLabel: '12 Bookworm',
    architecture: 'i386',
    availability: 'planned',
    description: 'desc',
    iconUrl: '/icons/os/debian.svg',
    minMemoryMiB: 128,
    imageRef: 'debian-12-i386-image',
    launchProfiles: [
      {
        id: 'default',
        engineId: 'v86',
        executionMode: 'browser',
        minMemoryMiB: 128,
      },
    ],
    requirements: ['WebAssembly'],
    accent: '#ec4264',
    accentRgb: '236,66,100',
    integrationNote: 'note',
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

class ControlledInstance implements VMInstance {
  readonly id = 'instance-1';
  readonly providerId = 'controlled';
  readonly systemId = 'debian-12-i386';
  readonly stop = vi.fn(async () => {
    this.emit({ type: 'state', state: 'stopped' });
  });
  readonly dispose = vi.fn(async () => {
    this.listeners.clear();
  });
  readonly listeners = new Set<(event: SessionEvent) => void>();

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    listener({ type: 'progress', phase: 'booting', loadedBytes: 1, totalBytes: 2 });
    listener({ type: 'state', state: 'running' });
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: SessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

class ControlledEngine implements VMEngine {
  readonly id = 'controlled';
  readonly instances: ControlledInstance[] = [];
  readonly startBarrier = deferred<void>();
  readonly startCalls: number[] = [];

  capabilities(): VMCapabilities {
    return NO_CAPABILITIES;
  }

  canRun(): boolean {
    return true;
  }

  async start(): Promise<VMInstance> {
    this.startCalls.push(this.startCalls.length + 1);
    await this.startBarrier.promise;
    const instance = new ControlledInstance();
    this.instances.push(instance);
    return instance;
  }
}

/** Instance qui rejoue un scénario fixe d'événements dès l'abonnement. */
class ScriptedInstance implements VMInstance {
  readonly id = 'scripted-instance';
  readonly providerId = 'scripted';
  readonly systemId = 'debian-12-i386';
  readonly stop = vi.fn(async () => undefined);
  readonly dispose = vi.fn(async () => {
    this.listeners.clear();
  });
  readonly listeners = new Set<(event: SessionEvent) => void>();

  constructor(private readonly script: readonly SessionEvent[]) {}

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    for (const event of this.script) listener(event);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

class ScriptedEngine implements VMEngine {
  readonly id = 'scripted';
  readonly instances: ScriptedInstance[] = [];

  constructor(private readonly script: readonly SessionEvent[]) {}

  capabilities(): VMCapabilities {
    return NO_CAPABILITIES;
  }

  canRun(): boolean {
    return true;
  }

  async start(): Promise<VMInstance> {
    const instance = new ScriptedInstance(this.script);
    this.instances.push(instance);
    return instance;
  }
}

/** Échoue au premier démarrage, réussit ensuite. */
class FlakyEngine implements VMEngine {
  readonly id = 'flaky';
  readonly instances: ControlledInstance[] = [];
  calls = 0;

  capabilities(): VMCapabilities {
    return NO_CAPABILITIES;
  }

  canRun(): boolean {
    return true;
  }

  async start(): Promise<VMInstance> {
    this.calls += 1;
    if (this.calls === 1) throw new Error('run boom');
    const instance = new ControlledInstance();
    this.instances.push(instance);
    return instance;
  }
}

/**
 * Instance dont le `subscribe` renvoie un désabonnement inopérant : simule un
 * moteur fautif qui continue d'émettre après sa libération.
 */
class LeakyInstance implements VMInstance {
  readonly id = 'leaky-instance';
  readonly providerId = 'leaky';
  readonly systemId = 'debian-12-i386';
  readonly stop = vi.fn(async () => undefined);
  readonly dispose = vi.fn(async () => undefined);
  #listener: ((event: SessionEvent) => void) | null = null;

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.#listener = listener;
    listener({ type: 'state', state: 'running' });
    return () => undefined;
  }

  emit(event: SessionEvent): void {
    this.#listener?.(event);
  }
}

class FixedEngine implements VMEngine {
  readonly id = 'fixed';

  constructor(private readonly instance: VMInstance) {}

  capabilities(): VMCapabilities {
    return NO_CAPABILITIES;
  }

  canRun(): boolean {
    return true;
  }

  async start(): Promise<VMInstance> {
    return this.instance;
  }
}

describe('SessionLifecycle', () => {
  it('passe de idle a preparing puis running et peut redemarrer apres stop', async () => {
    const engine = new ControlledEngine();
    const registry = new VMRegistry([engine]);
    const lifecycle = new SessionLifecycle(makeOS(), registry, 's1');

    const firstStart = lifecycle.start(document.createElement('div'));
    expect(lifecycle.snapshot.state).toBe('preparing');
    engine.startBarrier.resolve();
    await firstStart;
    expect(lifecycle.snapshot.state).toBe('running');
    expect(lifecycle.snapshot.phase).toBe('booting');

    await lifecycle.stop();
    expect(lifecycle.snapshot.state).toBe('stopped');
    expect(engine.instances[0]?.stop).toHaveBeenCalledTimes(1);
    expect(engine.instances[0]?.dispose).toHaveBeenCalledTimes(1);

    const secondStart = lifecycle.start(document.createElement('div'));
    expect(lifecycle.snapshot.state).toBe('preparing');
    await secondStart;
    expect(lifecycle.snapshot.state).toBe('running');
    expect(engine.startCalls).toHaveLength(2);
  });

  it('annule proprement un demarrage concurrent et nettoie l instance creee', async () => {
    const engine = new ControlledEngine();
    const registry = new VMRegistry([engine]);
    const lifecycle = new SessionLifecycle(makeOS(), registry, 's2');
    const mount = document.createElement('div');

    const startPromise = lifecycle.start(mount);
    const stopPromise = lifecycle.stop();
    engine.startBarrier.resolve();

    await Promise.all([startPromise, stopPromise]);

    expect(lifecycle.snapshot.state).toBe('stopped');
    expect(engine.instances).toHaveLength(1);
    expect(engine.instances[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('libere les ressources meme si le moteur echoue', async () => {
    const failingEngine: VMEngine = {
      id: 'failing',
      capabilities(): VMCapabilities {
        return NO_CAPABILITIES;
      },
      canRun(): boolean {
        return true;
      },
      async start(): Promise<VMInstance> {
        throw new Error('boom');
      },
    };

    const lifecycle = new SessionLifecycle(makeOS(), new VMRegistry([failingEngine]), 's3');
    await lifecycle.start(document.createElement('div'));

    expect(lifecycle.snapshot.state).toBe('error');
    expect(lifecycle.snapshot.error?.code).toBe('START_FAILED');
  });

  it('atteint running même si le moteur ne signale pas la phase booting', async () => {
    const instance: VMInstance = {
      id: 'instance-only-running',
      providerId: 'only-running',
      systemId: 'debian-12-i386',
      async stop() {},
      async dispose() {},
      subscribe(listener) {
        listener({ type: 'state', state: 'running' });
        return () => undefined;
      },
    };
    const engine: VMEngine = {
      id: 'only-running',
      capabilities(): VMCapabilities {
        return NO_CAPABILITIES;
      },
      canRun(): boolean {
        return true;
      },
      async start(): Promise<VMInstance> {
        return instance;
      },
    };

    const lifecycle = new SessionLifecycle(makeOS(), new VMRegistry([engine]), 's4');
    await lifecycle.start(document.createElement('div'));

    expect(lifecycle.snapshot.state).toBe('running');
  });

  it('recopie loadedBytes/totalBytes des événements progress dans le snapshot', async () => {
    const engine = new ControlledEngine();
    const registry = new VMRegistry([engine]);
    const lifecycle = new SessionLifecycle(makeOS(), registry, 's-bytes');

    const snapshots: Array<{ loadedBytes?: number; totalBytes?: number }> = [];
    lifecycle.subscribe((snapshot) => {
      const entry: { loadedBytes?: number; totalBytes?: number } = {};
      if (snapshot.loadedBytes !== undefined) entry.loadedBytes = snapshot.loadedBytes;
      if (snapshot.totalBytes !== undefined) entry.totalBytes = snapshot.totalBytes;
      snapshots.push(entry);
    });

    const started = lifecycle.start(document.createElement('div'));
    engine.startBarrier.resolve();
    await started;

    expect(lifecycle.snapshot.loadedBytes).toBe(1);
    expect(lifecycle.snapshot.totalBytes).toBe(2);
    expect(snapshots.some((s) => s.loadedBytes === 1 && s.totalBytes === 2)).toBe(true);

    await lifecycle.stop();
    expect(lifecycle.snapshot.loadedBytes).toBeUndefined();
    expect(lifecycle.snapshot.totalBytes).toBeUndefined();
  });

  it('recopie les diagnostics réseau et ne change pas l’état', async () => {
    const engine = new ControlledEngine();
    const registry = new VMRegistry([engine]);
    const lifecycle = new SessionLifecycle(makeOS(), registry, 's-network');
    const snapshots: SessionSnapshot[] = [];
    lifecycle.subscribe((snapshot) => snapshots.push(snapshot));

    const started = lifecycle.start(document.createElement('div'));
    engine.startBarrier.resolve();
    await started;
    expect(lifecycle.snapshot.state).toBe('running');

    engine.instances[0]?.emit({
      type: 'network',
      network: {
        mode: 'browser-fetch',
        status: 'connected',
        transport: 'fetch',
        verified: false,
        txBytes: 10,
        rxBytes: 20,
      },
    });

    expect(lifecycle.snapshot.state).toBe('running');
    expect(lifecycle.snapshot.network).toEqual({
      mode: 'browser-fetch',
      status: 'connected',
      transport: 'fetch',
      verified: false,
      txBytes: 10,
      rxBytes: 20,
    });
    expect(snapshots.some((s) => s.network?.txBytes === 10 && s.network.rxBytes === 20)).toBe(true);

    await lifecycle.stop();
    expect(lifecycle.snapshot.network).toBeUndefined();
  });

  it('signale les erreurs de nettoyage via le callback fourni', async () => {
    const instance: VMInstance = {
      id: 'instance-flaky',
      providerId: 'flaky',
      systemId: 'debian-12-i386',
      async stop() {
        throw new Error('stop boom');
      },
      async dispose() {
        throw new Error('dispose boom');
      },
      subscribe() {
        return () => undefined;
      },
    };
    const engine: VMEngine = {
      id: 'flaky',
      capabilities(): VMCapabilities {
        return NO_CAPABILITIES;
      },
      canRun(): boolean {
        return true;
      },
      async start(): Promise<VMInstance> {
        return instance;
      },
    };

    const errors: string[] = [];
    const lifecycle = new SessionLifecycle(
      makeOS(),
      new VMRegistry([engine]),
      's5',
      (_error, context) => errors.push(context),
    );
    await lifecycle.start(document.createElement('div'));
    await lifecycle.stop();

    expect(errors).toContain('stop');
    expect(errors).toContain('dispose');
  });

  it('libère l’instance après une erreur de téléchargement pendant le boot', async () => {
    const engine = new ScriptedEngine([
      { type: 'progress', phase: 'downloading', loadedBytes: 1, totalBytes: 10 },
      { type: 'error', code: 'DOWNLOAD_FAILED', message: 'téléchargement interrompu' },
    ]);
    const lifecycle = new SessionLifecycle(makeOS(), new VMRegistry([engine]), 's-download');

    await lifecycle.start(document.createElement('div'));

    expect(lifecycle.snapshot.state).toBe('error');
    expect(lifecycle.snapshot.error?.code).toBe('DOWNLOAD_FAILED');
    expect(engine.instances[0]?.stop).toHaveBeenCalledTimes(1);
    expect(engine.instances[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('libère l’instance après un échec de emulator.run()', async () => {
    const engine = new ScriptedEngine([
      { type: 'progress', phase: 'booting', loadedBytes: 1, totalBytes: 10 },
      { type: 'error', code: 'RUN_FAILED', message: 'échec du moteur' },
    ]);
    const lifecycle = new SessionLifecycle(makeOS(), new VMRegistry([engine]), 's-run');

    await lifecycle.start(document.createElement('div'));

    expect(lifecycle.snapshot.state).toBe('error');
    expect(lifecycle.snapshot.error?.code).toBe('RUN_FAILED');
    expect(engine.instances[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('stop() pendant un démarrage : aucun running tardif, instance libérée', async () => {
    const engine = new ControlledEngine();
    const registry = new VMRegistry([engine]);
    const lifecycle = new SessionLifecycle(makeOS(), registry, 's-stop-race');
    const states: VMState[] = [];
    lifecycle.subscribe((snapshot) => states.push(snapshot.state));

    const startPromise = lifecycle.start(document.createElement('div'));
    const stopPromise = lifecycle.stop();
    engine.startBarrier.resolve();
    await Promise.all([startPromise, stopPromise]);

    expect(lifecycle.snapshot.state).toBe('stopped');
    expect(states).not.toContain('running');
    expect(engine.instances[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('dispose() pendant une requête réseau : libération unique', async () => {
    const engine = new ControlledEngine();
    const registry = new VMRegistry([engine]);
    const lifecycle = new SessionLifecycle(makeOS(), registry, 's-dispose-race');

    const startPromise = lifecycle.start(document.createElement('div'));
    const disposePromise = lifecycle.dispose();
    engine.startBarrier.resolve();
    await Promise.all([startPromise, disposePromise]);

    expect(lifecycle.disposed).toBe(true);
    expect(engine.instances).toHaveLength(1);
    expect(engine.instances[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('redémarre après une erreur en créant une nouvelle instance', async () => {
    const engine = new FlakyEngine();
    const lifecycle = new SessionLifecycle(makeOS(), new VMRegistry([engine]), 's-restart');

    await lifecycle.start(document.createElement('div'));
    expect(lifecycle.snapshot.state).toBe('error');

    await lifecycle.start(document.createElement('div'));
    expect(lifecycle.snapshot.state).toBe('running');
    expect(engine.calls).toBe(2);
    expect(engine.instances).toHaveLength(1);
  });

  it('ignore un événement tardif après dispose()', async () => {
    const instance = new LeakyInstance();
    const lifecycle = new SessionLifecycle(
      makeOS(),
      new VMRegistry([new FixedEngine(instance)]),
      's-late',
    );

    await lifecycle.start(document.createElement('div'));
    expect(lifecycle.snapshot.state).toBe('running');

    await lifecycle.dispose();
    expect(lifecycle.snapshot.state).toBe('stopped');

    instance.emit({ type: 'state', state: 'preparing' });
    instance.emit({ type: 'error', code: 'LATE', message: 'tardif' });

    expect(lifecycle.snapshot.state).toBe('stopped');
    expect(lifecycle.snapshot.error).toBeUndefined();
  });
});
