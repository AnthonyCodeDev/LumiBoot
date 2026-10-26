import { describe, expect, it, vi } from 'vitest';
import type { V86 } from 'v86';
import type { GuestReadiness, SessionEvent } from '@lumiboot/contracts';
import { createNetworkController, defaultNetworkProfile } from '@lumiboot/vm-network';
import { V86Instance } from './v86-instance';
import type { V86ConsoleAdapter } from './console-adapter';

const GUEST_READY_MARKER = 'LUMIBOOT_GUEST_READY:debian-12-i386';
const READINESS: GuestReadiness = {
  marker: GUEST_READY_MARKER,
  channel: 'serial',
  timeoutMs: 120_000,
};

type Listener = (arg: unknown) => void;

class FakeV86 {
  readonly calls = { run: 0, stop: 0, destroy: 0 };
  /** Events passed to `remove_listener` (checks the detach). */
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
    screen: null,
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
    readiness: READINESS,
    ...(onCleanupError ? { onCleanupError } : {}),
  });
  instance.wire();
  return instance;
}

function emitMarker(emulator: FakeV86): void {
  for (const char of GUEST_READY_MARKER) emulator.emit('serial0-output-byte', char.charCodeAt(0));
}

describe('V86Instance', () => {
  it('on emulator-ready emits emulator-ready then booting and starts run, without reaching running', () => {
    const emulator = new FakeV86();
    const instance = createInstance(emulator);
    const events: SessionEvent[] = [];
    instance.subscribe((event) => events.push(event));

    emulator.emit('emulator-ready', undefined);

    expect(emulator.calls.run).toBe(1);
    // WASM ready (emulator-ready) is distinct from kernel boot (booting).
    expect(events).toEqual([
      { type: 'progress', phase: 'emulator-ready' },
      { type: 'progress', phase: 'booting' },
    ]);
    expect(instance.readiness).toBe('booting');
    expect(events.some((event) => event.type === 'state' && event.state === 'running')).toBe(false);
  });

  it('detects a fragmented marker and emits running only once', () => {
    const emulator = new FakeV86();
    const instance = createInstance(emulator);
    const events: SessionEvent[] = [];
    instance.subscribe((event) => events.push(event));

    emitMarker(emulator);

    const running = events.filter((event) => event.type === 'state' && event.state === 'running');
    expect(running).toHaveLength(1);
    // The transition is explicitly labeled "guest-ready" (strong proof).
    expect(events).toContainEqual({ type: 'progress', phase: 'guest-ready' });
    expect(instance.readiness).toBe('guest-ready');
  });

  it('reads the proof on the VGA channel when readiness.channel = vga', () => {
    const emulator = new FakeV86();
    const instance = new V86Instance({
      providerId: 'v86',
      systemId: 'sample',
      emulator: emulator as unknown as V86,
      console: createConsoleStub(),
      readiness: { marker: GUEST_READY_MARKER, channel: 'vga' },
    });
    instance.wire();
    const events: SessionEvent[] = [];
    instance.subscribe((event) => events.push(event));

    // The serial channel is NOT wired: only the screen text is watched.
    expect(emulator.listenerCount('serial0-output-byte')).toBe(0);
    expect(emulator.listenerCount('screen-put-char')).toBe(1);

    for (const char of GUEST_READY_MARKER) {
      emulator.emit('screen-put-char', [0, 0, char.charCodeAt(0)]);
    }

    const running = events.filter((event) => event.type === 'state' && event.state === 'running');
    expect(running).toHaveLength(1);
  });

  it('disk-boot mode: running only after a real read of the hda disk', () => {
    const emulator = new FakeV86();
    const instance = new V86Instance({
      providerId: 'v86',
      systemId: 'windows-7-pro-sp1-x86',
      emulator: emulator as unknown as V86,
      console: createConsoleStub(),
      readiness: {
        marker: 'LUMIBOOT_DISK_BOOT:windows-7-pro-sp1-x86',
        mode: 'disk-boot',
        channel: 'vga',
      },
    });
    instance.wire();
    const events: SessionEvent[] = [];
    instance.subscribe((event) => events.push(event));

    // Neither serial nor VGA: the proof comes from the hard disk.
    expect(emulator.listenerCount('serial0-output-byte')).toBe(0);
    expect(emulator.listenerCount('screen-put-char')).toBe(0);
    expect(emulator.listenerCount('ide-read-end')).toBe(1);

    // CD read (channel 1) or zero-length read: no boot proof.
    emulator.emit('ide-read-end', [1, 512, 1]);
    emulator.emit('ide-read-end', [0, 0, 0]);
    expect(events.some((event) => event.type === 'state' && event.state === 'running')).toBe(false);

    emulator.emit('ide-read-end', [0, 512, 1]);
    emulator.emit('ide-read-end', [0, 512, 1]);
    expect(
      events.filter((event) => event.type === 'state' && event.state === 'running'),
    ).toHaveLength(1);
    // The disk proof is labeled `disk-boot`, never presented as a guest marker
    // (`guest-ready`).
    expect(events).toContainEqual({ type: 'progress', phase: 'disk-boot' });
    expect(events).not.toContainEqual({ type: 'progress', phase: 'guest-ready' });
  });

  it('timeout without marker: BOOT_TIMEOUT, never running, console preserved', async () => {
    vi.useFakeTimers();
    try {
      const emulator = new FakeV86();
      const detach = vi.fn();
      const instance = new V86Instance({
        providerId: 'v86',
        systemId: 'sample',
        emulator: emulator as unknown as V86,
        console: {
          screen: null,
          attach: vi.fn(() => ({
            screenContainer: document.createElement('div'),
            serialTextarea: document.createElement('textarea'),
          })),
          detach,
        },
        readiness: { marker: GUEST_READY_MARKER, timeoutMs: 1000 },
      });
      instance.wire();
      const events: SessionEvent[] = [];
      instance.subscribe((event) => events.push(event));

      emulator.emit('emulator-ready', undefined);
      await vi.advanceTimersByTimeAsync(1000);

      // No simulated `running`: the failure is explicit and the state unverified.
      expect(events.some((event) => event.type === 'state' && event.state === 'running')).toBe(
        false,
      );
      expect(events).toEqual(
        expect.arrayContaining([
          { type: 'progress', phase: 'boot-timeout' },
          expect.objectContaining({ type: 'error', code: 'BOOT_TIMEOUT' }),
        ]),
      );
      expect(instance.readiness).toBe('unverified');

      // The screen (console) and the emulator stay alive: no cleanup.
      expect(detach).not.toHaveBeenCalled();
      expect(emulator.calls.stop).toBe(0);
      expect(emulator.calls.destroy).toBe(0);
      expect(emulator.listenerCount('serial0-output-byte')).toBe(1);

      // A LATE proof must never produce a `running`.
      emitMarker(emulator);
      await vi.advanceTimersByTimeAsync(5000);
      expect(events.some((event) => event.type === 'state' && event.state === 'running')).toBe(
        false,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('disk-boot: timeout without a disk read => BOOT_TIMEOUT labeled disk', async () => {
    vi.useFakeTimers();
    try {
      const emulator = new FakeV86();
      const instance = new V86Instance({
        providerId: 'v86',
        systemId: 'windows-7-pro-sp1-x86',
        emulator: emulator as unknown as V86,
        console: createConsoleStub(),
        readiness: {
          marker: 'LUMIBOOT_DISK_BOOT:windows-7-pro-sp1-x86',
          mode: 'disk-boot',
          channel: 'vga',
          timeoutMs: 1000,
        },
      });
      instance.wire();
      const events: SessionEvent[] = [];
      instance.subscribe((event) => events.push(event));

      emulator.emit('emulator-ready', undefined);
      await vi.advanceTimersByTimeAsync(1000);

      const error = events.find((event) => event.type === 'error');
      expect(error).toMatchObject({ code: 'BOOT_TIMEOUT' });
      // The message describes the real proof (disk read), not a guest marker.
      expect(error && error.type === 'error' ? error.message : '').toMatch(/disk/i);
      expect(events.some((event) => event.type === 'state' && event.state === 'running')).toBe(
        false,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not emit BOOT_TIMEOUT if the marker arrives before the delay', async () => {
    vi.useFakeTimers();
    try {
      const emulator = new FakeV86();
      const instance = new V86Instance({
        providerId: 'v86',
        systemId: 'sample',
        emulator: emulator as unknown as V86,
        console: createConsoleStub(),
        readiness: { marker: GUEST_READY_MARKER, timeoutMs: 1000 },
      });
      instance.wire();
      const events: SessionEvent[] = [];
      instance.subscribe((event) => events.push(event));

      emulator.emit('emulator-ready', undefined);
      emitMarker(emulator);
      await vi.advanceTimersByTimeAsync(2000);

      expect(events.some((event) => event.type === 'error')).toBe(false);
      expect(
        events.filter((event) => event.type === 'state' && event.state === 'running'),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits no running after BOOT_TIMEOUT, even if the marker arrives', async () => {
    vi.useFakeTimers();
    try {
      const emulator = new FakeV86();
      const instance = new V86Instance({
        providerId: 'v86',
        systemId: 'sample',
        emulator: emulator as unknown as V86,
        console: createConsoleStub(),
        readiness: { marker: GUEST_READY_MARKER, timeoutMs: 1000 },
      });
      instance.wire();
      const events: SessionEvent[] = [];
      instance.subscribe((event) => events.push(event));

      emulator.emit('emulator-ready', undefined);
      // Failure at expiry: unverified state…
      await vi.advanceTimersByTimeAsync(1000);
      // …then the marker arrives late: never a `running`.
      emitMarker(emulator);
      await vi.advanceTimersByTimeAsync(2000);

      expect(events.filter((event) => event.type === 'error')).toHaveLength(1);
      expect(
        events.filter((event) => event.type === 'state' && event.state === 'running'),
      ).toHaveLength(0);
      expect(instance.readiness).toBe('unverified');
    } finally {
      vi.useRealTimers();
    }
  });

  it('replays events emitted before the first subscriber', () => {
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

  it('stop and dispose are idempotent even if destroy fails', async () => {
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

  it('emits no late running after stop', async () => {
    const emulator = new FakeV86();
    const instance = createInstance(emulator);
    const events: SessionEvent[] = [];
    instance.subscribe((event) => events.push(event));

    await instance.stop();
    emitMarker(emulator);

    expect(events.some((event) => event.type === 'state' && event.state === 'running')).toBe(false);
  });

  it('spontaneous stop: publishes stopped, cleans up idempotently and never repeats', async () => {
    const emulator = new FakeV86();
    const detach = vi.fn();
    const instance = new V86Instance({
      providerId: 'v86',
      systemId: 'sample',
      emulator: emulator as unknown as V86,
      console: {
        screen: null,
        attach: vi.fn(() => ({
          screenContainer: document.createElement('div'),
          serialTextarea: document.createElement('textarea'),
        })),
        detach,
      },
      readiness: READINESS,
    });
    instance.wire();
    const events: SessionEvent[] = [];
    instance.subscribe((event) => events.push(event));

    // Spontaneous stop of the emulator (guest shutdown/crash).
    emulator.emit('emulator-stopped', undefined);
    await flushMicrotasks();

    // `stopping` then `stopped`: the lifecycle can reconcile the transition.
    expect(events).toEqual(
      expect.arrayContaining([
        { type: 'state', state: 'stopping' },
        { type: 'state', state: 'stopped' },
      ]),
    );
    expect(emulator.calls.stop).toBe(1);
    expect(emulator.calls.destroy).toBe(1);
    expect(detach).toHaveBeenCalledTimes(1);
    expect(emulator.listenerCount('serial0-output-byte')).toBe(0);

    // A later `stop()`/`dispose()` from the host has no additional effect.
    await instance.stop();
    await instance.dispose();
    expect(emulator.calls.stop).toBe(1);
    expect(emulator.calls.destroy).toBe(1);
    expect(
      events.filter((event) => event.type === 'state' && event.state === 'stopped'),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === 'state' && event.state === 'stopping'),
    ).toHaveLength(1);
  });

  it('ignores any late event after dispose', async () => {
    const emulator = new FakeV86();
    const instance = createInstance(emulator);
    const events: SessionEvent[] = [];
    instance.subscribe((event) => events.push(event));

    await instance.dispose();
    const after = events.length;

    emulator.emit('emulator-ready', undefined);
    emulator.emit('download-progress', { loaded: 1, total: 2, lengthComputable: true });
    emulator.emit('emulator-stopped', undefined);
    emitMarker(emulator);
    await flushMicrotasks();

    expect(events.length).toBe(after);
  });

  it('relays network diagnostics and detaches everything on dispose', async () => {
    const emulator = new FakeV86();
    const controller = createNetworkController({ profile: defaultNetworkProfile });
    await controller.start();
    const instance = new V86Instance({
      providerId: 'v86',
      systemId: 'debian-12-i386',
      emulator: emulator as unknown as V86,
      console: createConsoleStub(),
      readiness: READINESS,
      network: controller,
    });
    instance.wire();

    const events: SessionEvent[] = [];
    instance.subscribe((event) => events.push(event));

    // The initial state is replayed to the first subscriber (offline status).
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
    // `remove_listener` was indeed called for the three network events.
    expect(emulator.removed).toEqual(
      expect.arrayContaining(['eth-transmit-end', 'eth-receive-end', 'net0-send']),
    );
  });

  it('run() failure: emits an error and releases the network controller', async () => {
    const emulator = new FakeV86();
    emulator.runError = new Error('wasm broken');
    const controller = createNetworkController({ profile: defaultNetworkProfile });
    await controller.start();
    const disposeSpy = vi.spyOn(controller, 'dispose');

    const instance = new V86Instance({
      providerId: 'v86',
      systemId: 'debian-12-i386',
      emulator: emulator as unknown as V86,
      console: createConsoleStub(),
      readiness: READINESS,
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

  it('download error: emits an error and releases the network controller', async () => {
    const emulator = new FakeV86();
    const controller = createNetworkController({ profile: defaultNetworkProfile });
    await controller.start();
    const disposeSpy = vi.spyOn(controller, 'dispose');

    const instance = new V86Instance({
      providerId: 'v86',
      systemId: 'debian-12-i386',
      emulator: emulator as unknown as V86,
      console: createConsoleStub(),
      readiness: READINESS,
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
