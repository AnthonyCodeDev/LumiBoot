import { describe, expect, it, vi } from 'vitest';
import type { V86 } from 'v86';
import type { SessionEvent } from '@lumiboot/contracts';
import { createNetworkController, defaultNetworkProfile } from '@lumiboot/vm-network';
import { V86Instance } from './v86-instance';
import type { V86ConsoleAdapter } from './console-adapter';
import { GUEST_READY_MARKER } from './guest-ready-detector';

type Listener = (arg: unknown) => void;

class FakeV86 {
  readonly calls = { run: 0, stop: 0, destroy: 0 };
  /** Événements passés à `remove_listener` (vérifie le détachement). */
  readonly removed: string[] = [];
  destroyError: Error | null = null;
  runError: Error | null = null;
  readonly #listeners = new Map<string, Set<Listener>>();

  add_listener(event: string, listener: Listener): void {
    const set = this.#listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    this.#listeners.set(event, set);
  }

  remove_listener(event: string, listener: Listener): void {
    this.removed.push(event);
    this.#listeners.get(event)?.delete(listener);
  }

  async run(): Promise<void> {
    this.calls.run += 1;
    if (this.runError) throw this.runError;
  }

  async stop(): Promise<void> {
    this.calls.stop += 1;
    this.emit('emulator-stopped', undefined);
  }

  async destroy(): Promise<void> {
    this.calls.destroy += 1;
    if (this.destroyError) throw this.destroyError;
  }

  emit(event: string, arg: unknown): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(arg);
  }

  listenerCount(event: string): number {
    return this.#listeners.get(event)?.size ?? 0;
  }
}

function createConsoleStub(): V86ConsoleAdapter {
  return {
    attach: vi.fn(() => ({
      screenContainer: document.createElement('div'),
      serialTextarea: document.createElement('textarea'),
    })),
    detach: vi.fn(),
  };
}

function createInstance(emulator: FakeV86, onCleanupError?: (error: unknown) => void): V86Instance {
  const instance = new V86Instance({
    providerId: 'v86',
    systemId: 'debian-12-i386',
    emulator: emulator as unknown as V86,
    console: createConsoleStub(),
    ...(onCleanupError ? { onCleanupError } : {}),
  });
  instance.wire();
  return instance;
}

function emitMarker(emulator: FakeV86): void {
  for (const char of GUEST_READY_MARKER) emulator.emit('serial0-output-byte', char.charCodeAt(0));
}

describe('V86Instance', () => {
  it('sur emulator-ready émet booting et lance run, sans passer running', () => {
    const emulator = new FakeV86();
    const instance = createInstance(emulator);
    const events: SessionEvent[] = [];
    instance.subscribe((event) => events.push(event));

    emulator.emit('emulator-ready', undefined);

    expect(emulator.calls.run).toBe(1);
    expect(events).toEqual([{ type: 'progress', phase: 'booting' }]);
    expect(events.some((event) => event.type === 'state' && event.state === 'running')).toBe(false);
  });

  it('détecte le marqueur fragmenté et n’émet running qu’une seule fois', () => {
    const emulator = new FakeV86();
    const instance = createInstance(emulator);
    const events: SessionEvent[] = [];
    instance.subscribe((event) => events.push(event));

    emitMarker(emulator);

    const running = events.filter((event) => event.type === 'state' && event.state === 'running');
    expect(running).toHaveLength(1);
  });

  it('rejoue les événements émis avant le premier abonné', () => {
    const emulator = new FakeV86();
    const instance = createInstance(emulator);
    emulator.emit('download-progress', { loaded: 10, total: 100, lengthComputable: true });

    const events: SessionEvent[] = [];
    instance.subscribe((event) => events.push(event));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'progress',
      phase: 'downloading',
      loadedBytes: 10,
      totalBytes: 100,
    });
  });

  it('stop et dispose sont idempotents même si destroy échoue', async () => {
    const emulator = new FakeV86();
    emulator.destroyError = new Error('boom');
    const cleanupErrors: unknown[] = [];
    const instance = createInstance(emulator, (error) => cleanupErrors.push(error));

    await instance.stop();
    await instance.stop();
    await instance.dispose();

    expect(emulator.calls.stop).toBe(1);
    expect(emulator.calls.destroy).toBe(1);
    expect(cleanupErrors).toHaveLength(1);
    expect(emulator.listenerCount('serial0-output-byte')).toBe(0);
  });

  it('n’émet aucun running tardif après stop', async () => {
    const emulator = new FakeV86();
    const instance = createInstance(emulator);
    const events: SessionEvent[] = [];
    instance.subscribe((event) => events.push(event));

    await instance.stop();
    emitMarker(emulator);

    expect(events.some((event) => event.type === 'state' && event.state === 'running')).toBe(false);
  });

  it('relaie les diagnostics réseau et détache tout à dispose', async () => {
    const emulator = new FakeV86();
    const controller = createNetworkController({ profile: defaultNetworkProfile });
    await controller.start();
    const instance = new V86Instance({
      providerId: 'v86',
      systemId: 'debian-12-i386',
      emulator: emulator as unknown as V86,
      console: createConsoleStub(),
      network: controller,
    });
    instance.wire();

    const events: SessionEvent[] = [];
    instance.subscribe((event) => events.push(event));

    // L'état initial est rejoué au premier abonné (statut offline).
    expect(events.some((event) => event.type === 'network')).toBe(true);

    emulator.emit('net0-send', new Uint8Array(64));
    const networkEvents = events.filter((event) => event.type === 'network');
    expect(networkEvents.at(-1)).toEqual({
      type: 'network',
      network: expect.objectContaining({ txBytes: 64 }),
    });

    await instance.dispose();
    const afterDispose = events.length;

    emulator.emit('net0-send', new Uint8Array(64));
    controller.reportTx(32);

    expect(events.length).toBe(afterDispose);
    expect(emulator.listenerCount('net0-send')).toBe(0);
    expect(emulator.listenerCount('eth-transmit-end')).toBe(0);
    expect(emulator.listenerCount('eth-receive-end')).toBe(0);
    // `remove_listener` a bien été appelé pour les trois événements réseau.
    expect(emulator.removed).toEqual(
      expect.arrayContaining(['eth-transmit-end', 'eth-receive-end', 'net0-send']),
    );
  });

  it('échec de run() : émet une erreur et libère le contrôleur réseau', async () => {
    const emulator = new FakeV86();
    emulator.runError = new Error('wasm cassé');
    const controller = createNetworkController({ profile: defaultNetworkProfile });
    await controller.start();
    const disposeSpy = vi.spyOn(controller, 'dispose');

    const instance = new V86Instance({
      providerId: 'v86',
      systemId: 'debian-12-i386',
      emulator: emulator as unknown as V86,
      console: createConsoleStub(),
      network: controller,
    });
    instance.wire();

    const events: SessionEvent[] = [];
    instance.subscribe((event) => events.push(event));

    emulator.emit('emulator-ready', undefined);
    await flushMicrotasks();

    expect(events).toEqual(
      expect.arrayContaining([
        { type: 'progress', phase: 'booting' },
        expect.objectContaining({ type: 'error', code: 'START_FAILED' }),
      ]),
    );
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(emulator.listenerCount('net0-send')).toBe(0);
    expect(emulator.removed).toEqual(
      expect.arrayContaining(['eth-transmit-end', 'eth-receive-end', 'net0-send']),
    );
  });

  it('erreur de téléchargement : émet une erreur et libère le contrôleur réseau', async () => {
    const emulator = new FakeV86();
    const controller = createNetworkController({ profile: defaultNetworkProfile });
    await controller.start();
    const disposeSpy = vi.spyOn(controller, 'dispose');

    const instance = new V86Instance({
      providerId: 'v86',
      systemId: 'debian-12-i386',
      emulator: emulator as unknown as V86,
      console: createConsoleStub(),
      network: controller,
    });
    instance.wire();

    const events: SessionEvent[] = [];
    instance.subscribe((event) => events.push(event));

    emulator.emit('download-error', {
      file_index: 0,
      file_count: 1,
      file_name: 'rootfs.img',
      lengthComputable: true,
      total: 10,
      loaded: 0,
    });
    await flushMicrotasks();

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'error', code: 'ASSET_DOWNLOAD_FAILED' }),
      ]),
    );
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(emulator.listenerCount('net0-send')).toBe(0);
  });
});

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
