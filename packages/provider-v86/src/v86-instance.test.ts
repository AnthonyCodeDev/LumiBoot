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
  it('sur emulator-ready émet emulator-ready puis booting et lance run, sans passer running', () => {
    const emulator = new FakeV86();
    const instance = createInstance(emulator);
    const events: SessionEvent[] = [];
    instance.subscribe((event) => events.push(event));

    emulator.emit('emulator-ready', undefined);

    expect(emulator.calls.run).toBe(1);
    // WASM prêt (emulator-ready) est distinct du démarrage du noyau (booting).
    expect(events).toEqual([
      { type: 'progress', phase: 'emulator-ready' },
      { type: 'progress', phase: 'booting' },
    ]);
    expect(instance.readiness).toBe('booting');
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
    // La transition est explicitement étiquetée « guest-ready » (preuve forte).
    expect(events).toContainEqual({ type: 'progress', phase: 'guest-ready' });
    expect(instance.readiness).toBe('guest-ready');
  });

  it('lit la preuve sur le canal VGA quand readiness.channel = vga', () => {
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

    // Le canal série n'est PAS branché : seul le texte écran est surveillé.
    expect(emulator.listenerCount('serial0-output-byte')).toBe(0);
    expect(emulator.listenerCount('screen-put-char')).toBe(1);

    for (const char of GUEST_READY_MARKER) {
      emulator.emit('screen-put-char', [0, 0, char.charCodeAt(0)]);
    }

    const running = events.filter((event) => event.type === 'state' && event.state === 'running');
    expect(running).toHaveLength(1);
  });

  it('mode disk-boot : running seulement après une lecture réelle du disque hda', () => {
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

    // Ni série ni VGA : la preuve vient du disque dur.
    expect(emulator.listenerCount('serial0-output-byte')).toBe(0);
    expect(emulator.listenerCount('screen-put-char')).toBe(0);
    expect(emulator.listenerCount('ide-read-end')).toBe(1);

    // Lecture du CD (canal 1) ou lecture nulle : aucune preuve de démarrage.
    emulator.emit('ide-read-end', [1, 512, 1]);
    emulator.emit('ide-read-end', [0, 0, 0]);
    expect(events.some((event) => event.type === 'state' && event.state === 'running')).toBe(false);

    emulator.emit('ide-read-end', [0, 512, 1]);
    emulator.emit('ide-read-end', [0, 512, 1]);
    expect(
      events.filter((event) => event.type === 'state' && event.state === 'running'),
    ).toHaveLength(1);
    // La preuve disque est étiquetée `disk-boot`, jamais présentée comme un
    // marqueur invité (`guest-ready`).
    expect(events).toContainEqual({ type: 'progress', phase: 'disk-boot' });
    expect(events).not.toContainEqual({ type: 'progress', phase: 'guest-ready' });
  });

  it('timeout sans marqueur : BOOT_TIMEOUT, jamais running, console préservée', async () => {
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

      // Aucun `running` simulé : l'échec est explicite et l'état non vérifié.
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

      // L'écran (console) et l'émulateur restent vivants : aucun nettoyage.
      expect(detach).not.toHaveBeenCalled();
      expect(emulator.calls.stop).toBe(0);
      expect(emulator.calls.destroy).toBe(0);
      expect(emulator.listenerCount('serial0-output-byte')).toBe(1);

      // Une preuve TARDIVE ne doit jamais produire de `running`.
      emitMarker(emulator);
      await vi.advanceTimersByTimeAsync(5000);
      expect(events.some((event) => event.type === 'state' && event.state === 'running')).toBe(
        false,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('disk-boot : timeout sans lecture disque => BOOT_TIMEOUT étiqueté disque', async () => {
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
      // Le message décrit la preuve réelle (lecture disque), pas un marqueur invité.
      expect(error && error.type === 'error' ? error.message : '').toMatch(/disque/i);
      expect(events.some((event) => event.type === 'state' && event.state === 'running')).toBe(
        false,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('n’émet pas BOOT_TIMEOUT si le marqueur arrive avant le délai', async () => {
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

  it('n’émet aucun running après BOOT_TIMEOUT, même si le marqueur arrive', async () => {
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
      // Échec à l'échéance : état non vérifié…
      await vi.advanceTimersByTimeAsync(1000);
      // …puis le marqueur arrive tardivement : jamais de `running`.
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

  it('arrêt spontané : publie stopped, nettoie idempotemment et ne se répète pas', async () => {
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

    // Arrêt spontané de l'émulateur (extinction/crash invité).
    emulator.emit('emulator-stopped', undefined);
    await flushMicrotasks();

    // `stopping` puis `stopped` : le cycle de vie peut réconcilier la transition.
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

    // Un `stop()`/`dispose()` ultérieur de l'hôte est sans effet supplémentaire.
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

  it('ignore tout événement tardif après dispose', async () => {
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

  it('relaie les diagnostics réseau et détache tout à dispose', async () => {
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
