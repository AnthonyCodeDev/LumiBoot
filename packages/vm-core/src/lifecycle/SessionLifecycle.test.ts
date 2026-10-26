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

/** Instance that replays a fixed event script as soon as it is subscribed. */
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

/** Fails on the first start, succeeds afterwards. */
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
 * Instance whose `subscribe` returns an ineffective unsubscribe: simulates a
 * faulty engine that keeps emitting after its release.
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

/**
 * Controllable instance: `subscribe` replays an initial state (`booting` or
 * `running`) then lets the test emit any event. `leaky` simulates a faulty
 * engine whose unsubscribe is ineffective (late events received after release).
 */
class ManualInstance implements VMInstance {
  readonly id = 'manual-instance';
  readonly providerId = 'manual';
  readonly systemId = 'debian-12-i386';
  readonly stop = vi.fn(async () => undefined);
  readonly dispose = vi.fn(async () => undefined);
  readonly listeners = new Set<(event: SessionEvent) => void>();

  constructor(
    private readonly initial: 'booting' | 'running',
    private readonly leaky = false,
  ) {}

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    listener({ type: 'progress', phase: 'booting' });
    if (this.initial === 'running') listener({ type: 'state', state: 'running' });
    return () => {
      if (!this.leaky) this.listeners.delete(listener);
    };
  }

  emit(event: SessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

class ManualEngine implements VMEngine {
  readonly id = 'manual';
  readonly instances: ManualInstance[] = [];

  constructor(
    private readonly initial: 'booting' | 'running' = 'running',
    private readonly leaky = false,
  ) {}

  capabilities(): VMCapabilities {
    return NO_CAPABILITIES;
  }

  canRun(): boolean {
    return true;
  }

  async start(): Promise<VMInstance> {
    const instance = new ManualInstance(this.initial, this.leaky);
    this.instances.push(instance);
    return instance;
  }
}

/** Instance whose `stop()` and `dispose()` reject (destroy failure). */
class FailingCleanupInstance implements VMInstance {
  readonly id = 'failing-cleanup';
  readonly providerId = 'failing';
  readonly systemId = 'debian-12-i386';
  readonly stop = vi.fn(async () => {
    throw new Error('stop boom');
  });
  readonly dispose = vi.fn(async () => {
    throw new Error('dispose boom');
  });
  #listener: ((event: SessionEvent) => void) | null = null;

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.#listener = listener;
    listener({ type: 'state', state: 'running' });
    return () => {
      this.#listener = null;
    };
  }

  emit(event: SessionEvent): void {
    this.#listener?.(event);
  }
}

describe('SessionLifecycle', () => {
  it('goes from idle to preparing then running and can restart after stop', async () => {
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

  it('cleanly cancels a concurrent start and cleans up the created instance', async () => {
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

  it('releases resources even if the engine fails', async () => {
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

  it('reaches running even if the engine does not report the booting phase', async () => {
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

  it('copies loadedBytes/totalBytes from progress events into the snapshot', async () => {
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

  it('copies network diagnostics and does not change the state', async () => {
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

  it('reports cleanup errors through the provided callback', async () => {
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

  it('releases the instance after a download error during boot', async () => {
    const engine = new ScriptedEngine([
      { type: 'progress', phase: 'downloading', loadedBytes: 1, totalBytes: 10 },
      { type: 'error', code: 'DOWNLOAD_FAILED', message: 'download interrupted' },
    ]);
    const lifecycle = new SessionLifecycle(makeOS(), new VMRegistry([engine]), 's-download');

    await lifecycle.start(document.createElement('div'));

    expect(lifecycle.snapshot.state).toBe('error');
    expect(lifecycle.snapshot.error?.code).toBe('DOWNLOAD_FAILED');
    expect(engine.instances[0]?.stop).toHaveBeenCalledTimes(1);
    expect(engine.instances[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('releases the instance after an emulator.run() failure', async () => {
    const engine = new ScriptedEngine([
      { type: 'progress', phase: 'booting', loadedBytes: 1, totalBytes: 10 },
      { type: 'error', code: 'RUN_FAILED', message: 'engine failure' },
    ]);
    const lifecycle = new SessionLifecycle(makeOS(), new VMRegistry([engine]), 's-run');

    await lifecycle.start(document.createElement('div'));

    expect(lifecycle.snapshot.state).toBe('error');
    expect(lifecycle.snapshot.error?.code).toBe('RUN_FAILED');
    expect(engine.instances[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('stop() during a start: no late running, instance released', async () => {
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

  it('dispose() during a network request: single release', async () => {
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

  it('restarts after an error by creating a new instance', async () => {
    const engine = new FlakyEngine();
    const lifecycle = new SessionLifecycle(makeOS(), new VMRegistry([engine]), 's-restart');

    await lifecycle.start(document.createElement('div'));
    expect(lifecycle.snapshot.state).toBe('error');

    await lifecycle.start(document.createElement('div'));
    expect(lifecycle.snapshot.state).toBe('running');
    expect(engine.calls).toBe(2);
    expect(engine.instances).toHaveLength(1);
  });

  it('ignores a late event after dispose()', async () => {
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
    instance.emit({ type: 'error', code: 'LATE', message: 'late' });

    expect(lifecycle.snapshot.state).toBe('stopped');
    expect(lifecycle.snapshot.error).toBeUndefined();
  });

  it('spontaneous stop from running: traverses stopping, releases and allows a restart', async () => {
    const engine = new ManualEngine('running');
    const lifecycle = new SessionLifecycle(makeOS(), new VMRegistry([engine]), 's-spont-running');
    const states: VMState[] = [];
    lifecycle.subscribe((snapshot) => states.push(snapshot.state));

    await lifecycle.start(document.createElement('div'));
    expect(lifecycle.snapshot.state).toBe('running');

    const instance = engine.instances[0]!;
    // Both the direct `stopped` signal and the `stopping` -> `stopped` sequence
    // emitted by the v86 provider must be reconciled.
    instance.emit({ type: 'state', state: 'stopping' });
    instance.emit({ type: 'state', state: 'stopped' });
    // The terminal `stop()` waits for the cleanup in flight (stop then dispose).
    await lifecycle.stop();

    expect(lifecycle.snapshot.state).toBe('stopped');
    expect(states).toContain('stopping');
    expect(instance.stop).toHaveBeenCalledTimes(1);
    expect(instance.dispose).toHaveBeenCalledTimes(1);

    // No zombie VM: the released instance no longer prevents a restart.
    await lifecycle.start(document.createElement('div'));
    expect(lifecycle.snapshot.state).toBe('running');
    expect(engine.instances).toHaveLength(2);
  });

  it('spontaneous stop from running (direct stopped): reaches stopped without ignore', async () => {
    const engine = new ManualEngine('running');
    const lifecycle = new SessionLifecycle(makeOS(), new VMRegistry([engine]), 's-spont-direct');

    await lifecycle.start(document.createElement('div'));
    expect(lifecycle.snapshot.state).toBe('running');

    engine.instances[0]!.emit({ type: 'state', state: 'stopped' });
    await lifecycle.stop();

    expect(lifecycle.snapshot.state).toBe('stopped');
    expect(engine.instances[0]!.dispose).toHaveBeenCalledTimes(1);
  });

  it('spontaneous stop from booting: reaches stopped without ever running', async () => {
    const engine = new ManualEngine('booting');
    const lifecycle = new SessionLifecycle(makeOS(), new VMRegistry([engine]), 's-spont-booting');
    const states: VMState[] = [];
    lifecycle.subscribe((snapshot) => states.push(snapshot.state));

    await lifecycle.start(document.createElement('div'));
    expect(lifecycle.snapshot.state).toBe('booting');

    engine.instances[0]!.emit({ type: 'state', state: 'stopped' });
    await lifecycle.stop();

    expect(lifecycle.snapshot.state).toBe('stopped');
    expect(states).not.toContain('running');
    expect(engine.instances[0]!.dispose).toHaveBeenCalledTimes(1);
  });

  it('idempotent spontaneous stop: a single cleanup and no late event', async () => {
    const engine = new ManualEngine('running', true);
    const lifecycle = new SessionLifecycle(makeOS(), new VMRegistry([engine]), 's-spont-idem');

    await lifecycle.start(document.createElement('div'));
    const instance = engine.instances[0]!;

    instance.emit({ type: 'state', state: 'stopped' });
    // Late events from a faulty engine (ineffective unsubscribe): ignored.
    instance.emit({ type: 'state', state: 'stopped' });
    instance.emit({ type: 'state', state: 'running' });
    instance.emit({ type: 'progress', phase: 'booting', loadedBytes: 5, totalBytes: 10 });
    instance.emit({ type: 'error', code: 'LATE', message: 'late' });
    await lifecycle.stop();

    expect(lifecycle.snapshot.state).toBe('stopped');
    expect(lifecycle.snapshot.error).toBeUndefined();
    expect(lifecycle.snapshot.phase).toBeUndefined();
    expect(lifecycle.snapshot.loadedBytes).toBeUndefined();
    expect(instance.stop).toHaveBeenCalledTimes(1);
    expect(instance.dispose).toHaveBeenCalledTimes(1);
  });

  it('spontaneous stop: a destroy failure is reported without rejecting', async () => {
    const errors: string[] = [];
    const instance = new FailingCleanupInstance();
    const lifecycle = new SessionLifecycle(
      makeOS(),
      new VMRegistry([new FixedEngine(instance)]),
      's-spont-destroy',
      (_error, context) => errors.push(context),
    );

    await lifecycle.start(document.createElement('div'));
    expect(lifecycle.snapshot.state).toBe('running');

    instance.emit({ type: 'state', state: 'stopped' });
    // The terminal `stop()` waits for the cleanup in flight so it only hands
    // back control once the release is over (even if it fails).
    await lifecycle.stop();

    expect(lifecycle.snapshot.state).toBe('stopped');
    expect(errors).toContain('stop');
    expect(errors).toContain('dispose');
  });
});
