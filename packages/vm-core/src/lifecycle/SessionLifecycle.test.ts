import { describe, expect, it, vi } from 'vitest';
import type { OSDefinition, SessionEvent } from '@lumiboot/contracts';
import { SessionLifecycle } from './SessionLifecycle';
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
});
