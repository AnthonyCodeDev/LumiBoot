import type { Event as V86Event, V86 } from 'v86';
import type { GuestReadiness, SessionEvent } from '@lumiboot/contracts';
import type { NetworkController } from '@lumiboot/vm-network';
import { createSessionId, type VMInstance } from '@lumiboot/vm-core';
import type { V86ConsoleAdapter } from './console-adapter';
import { attachConsoleWheelScroll } from './console-scroll';
import { GuestReadyDetector } from './guest-ready-detector';
import { attachNetworkDiagnostics } from './network/V86NetworkAdapter';

export interface V86InstanceDeps {
  readonly providerId: string;
  readonly systemId: string;
  readonly emulator: V86;
  readonly console: V86ConsoleAdapter;
  /** Expected boot proof from the profile. */
  readonly readiness: GuestReadiness;
  readonly id?: string;
  readonly onCleanupError?: (error: unknown) => void;
  readonly network?: NetworkController;
}

/**
 * `emulator-error` is emitted by libv86 (CPU worker init failure, parallel JIT
 * failure, WASM core error) but is absent from the published `Event` map.
 */
interface EmulatorErrorBus {
  add_listener(event: 'emulator-error', listener: (argument: unknown) => void): void;
  remove_listener(event: 'emulator-error', listener: (argument: unknown) => void): void;
}

/** Ordered stages; `unverified` never means `guest-ready`. */
export type V86ReadinessStage =
  'idle' | 'emulator-ready' | 'booting' | 'guest-ready' | 'unverified';

/** Progress phases; `diskBoot` is a weak BIOS-level proof. */
export const V86_PROGRESS = {
  emulatorReady: 'emulator-ready',
  booting: 'booting',
  guestReady: 'guest-ready',
  diskBoot: 'disk-boot',
  bootTimeout: 'boot-timeout',
} as const;

/** `running` once, only on the profile's proof; a timeout never stops the VM. */
export class V86Instance implements VMInstance {
  readonly id: string;
  readonly providerId: string;
  readonly systemId: string;

  readonly #emulator: V86;
  readonly #console: V86ConsoleAdapter;
  readonly #detector: GuestReadyDetector;
  readonly #network: NetworkController | undefined;
  readonly #onCleanupError: ((error: unknown) => void) | undefined;
  readonly #listeners = new Set<(event: SessionEvent) => void>();

  #detachNetwork: (() => void) | null = null;
  #unsubscribeNetwork: (() => void) | null = null;
  #detachScroll: (() => void) | null = null;
  #pending: SessionEvent[] = [];
  #hasSubscriber = false;
  #cleanupPromise: Promise<void> | null = null;
  #stopping = false;
  #stopSignalled = false;
  #disposed = false;
  #runningEmitted = false;
  /** Diagnostic only: the delay expired, it never blocks a later proof. */
  #bootTimedOut = false;
  #readinessStage: V86ReadinessStage = 'idle';
  #readyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: V86InstanceDeps) {
    this.id = deps.id ?? createSessionId();
    this.providerId = deps.providerId;
    this.systemId = deps.systemId;
    this.#emulator = deps.emulator;
    this.#console = deps.console;
    this.#detector = new GuestReadyDetector(deps.readiness);
    this.#network = deps.network;
    this.#onCleanupError = deps.onCleanupError;
  }

  /** `emulator-error` lives outside the typed `Event` map of `v86`. */
  get #errorBus(): EmulatorErrorBus {
    return this.#emulator as unknown as EmulatorErrorBus;
  }

  get readiness(): V86ReadinessStage {
    return this.#readinessStage;
  }

  /** Call once, right after construction. */
  wire(): void {
    const emulator = this.#emulator;
    emulator.add_listener('emulator-ready', this.#onEmulatorReady);
    emulator.add_listener('emulator-stopped', this.#onEmulatorStopped);
    emulator.add_listener('download-progress', this.#onDownloadProgress);
    emulator.add_listener('download-error', this.#onDownloadError);
    this.#errorBus.add_listener('emulator-error', this.#onEmulatorError);
    if (this.#detector.mode === 'disk-boot') {
      emulator.add_listener('ide-read-end', this.#onDiskRead);
    } else if (this.#detector.channel === 'vga') {
      emulator.add_listener('screen-put-char', this.#onScreenChar);
    } else {
      emulator.add_listener('serial0-output-byte', this.#onSerialByte);
    }
    this.#wireNetwork();
    // Wheel becomes Shift+PageUp/PageDown for Linux console scrollback.
    const screen = this.#console.screen;
    if (screen !== null) {
      this.#detachScroll = attachConsoleWheelScroll(screen, this.#emulator);
    }
  }

  #wireNetwork(): void {
    const network = this.#network;
    if (network === undefined) return;
    this.#detachNetwork = attachNetworkDiagnostics(this.#emulator, network);
    this.#unsubscribeNetwork = network.subscribe((diagnostics) => {
      this.#emit({ type: 'network', network: diagnostics });
    });
    // Initial state replayed to the first subscriber, even without later change.
    this.#emit({ type: 'network', network: network.snapshot() });
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.#listeners.add(listener);
    if (!this.#hasSubscriber) {
      this.#hasSubscriber = true;
      const replay = this.#pending;
      this.#pending = [];
      for (const event of replay) listener(event);
    }
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async stop(): Promise<void> {
    if (this.#disposed) return;
    this.#stopping = true;
    await this.#cleanup();
    this.#signalStopped();
  }

  async dispose(): Promise<void> {
    this.#stopping = true;
    await this.#cleanup();
    this.#disposed = true;
    this.#listeners.clear();
    this.#pending = [];
  }

  /** The lifecycle forbids `running -> stopped`: go through `stopping`. */
  #signalStopped(): void {
    if (this.#stopSignalled) return;
    this.#stopSignalled = true;
    this.#stopping = true;
    this.#clearReadyTimeout();
    this.#emit({ type: 'state', state: 'stopping' });
    this.#emit({ type: 'state', state: 'stopped' });
  }

  #emit(event: SessionEvent): void {
    if (this.#disposed) return;
    if (!this.#hasSubscriber) {
      this.#pending.push(event);
      return;
    }
    for (const listener of this.#listeners) listener(event);
  }

  #emitRunning(proof: 'guest-marker' | 'disk-boot'): void {
    if (this.#runningEmitted || this.#stopping || this.#disposed) return;
    this.#runningEmitted = true;
    this.#clearReadyTimeout();
    this.#readinessStage = 'guest-ready';
    this.#emit({
      type: 'progress',
      phase: proof === 'disk-boot' ? V86_PROGRESS.diskBoot : V86_PROGRESS.guestReady,
    });
    this.#emit({ type: 'state', state: 'running' });
  }

  readonly #onEmulatorReady = (): void => {
    if (this.#disposed || this.#stopping) return;
    // WASM ready; this proves nothing about the guest.
    this.#readinessStage = 'emulator-ready';
    this.#emit({ type: 'progress', phase: V86_PROGRESS.emulatorReady });
    this.#readinessStage = 'booting';
    this.#emit({ type: 'progress', phase: V86_PROGRESS.booting });
    this.#armReadyTimeout();
    void this.#emulator.run().catch((error: unknown) => {
      this.#failBoot('START_FAILED', `The guest kernel could not boot: ${describeError(error)}`);
    });
  };

  /** Expiry publishes `boot-timeout` only: the VM stays alive and `booting`. */
  #armReadyTimeout(): void {
    if (this.#readyTimer !== null) return;
    this.#readyTimer = setTimeout(() => {
      this.#readyTimer = null;
      if (this.#disposed || this.#stopping || this.#bootTimedOut || this.#detector.detected) {
        return;
      }
      this.#publishBootTimeout();
    }, this.#detector.timeoutMs);
  }

  /** Diagnostic only, never re-armed: a late proof still triggers `running`. */
  #publishBootTimeout(): void {
    if (this.#bootTimedOut) return;
    this.#bootTimedOut = true;
    this.#readinessStage = 'unverified';
    this.#emit({ type: 'progress', phase: V86_PROGRESS.bootTimeout });
  }

  #clearReadyTimeout(): void {
    if (this.#readyTimer === null) return;
    clearTimeout(this.#readyTimer);
    this.#readyTimer = null;
  }

  /** `#cleanup()`, not `dispose()`: pending events must reach a late subscriber. */
  #failBoot(code: string, message: string): void {
    this.#emit({ type: 'error', code, message });
    void this.#cleanup();
  }

  readonly #onSerialByte = (byte: number): void => {
    if (this.#disposed || this.#stopping) return;
    if (this.#detector.pushByte(byte)) {
      this.#emitRunning('guest-marker');
    }
  };

  readonly #onScreenChar = (arg: V86Event['screen-put-char']): void => {
    if (this.#disposed || this.#stopping) return;
    if (this.#detector.pushByte(arg[2])) {
      this.#emitRunning('guest-marker');
    }
  };

  /** `disk-boot` proof: first real read of `hda`, a weak BIOS-level signal. */
  readonly #onDiskRead = (arg: V86Event['ide-read-end']): void => {
    if (this.#disposed || this.#stopping) return;
    const [channelNr, byteCount] = arg;
    if (channelNr !== 0 || byteCount <= 0) return;
    if (this.#detector.markDiskBoot()) {
      this.#emitRunning('disk-boot');
    }
  };

  readonly #onDownloadProgress = (arg: V86Event['download-progress']): void => {
    if (this.#disposed || this.#stopping) return;
    const event: SessionEvent = {
      type: 'progress',
      phase: 'downloading',
      loadedBytes: arg.loaded,
      totalBytes: arg.total,
    };
    this.#emit(event);
  };

  readonly #onDownloadError = (arg: V86Event['download-error']): void => {
    if (this.#disposed || this.#stopping) return;
    // Fatal: releases resources like a `run()` failure.
    this.#failBoot('ASSET_DOWNLOAD_FAILED', `Failed to load artifact "${arg.file_name}".`);
  };

  /** libv86 also leaks the worker/TaskError through `console.error`; surface it. */
  readonly #onEmulatorError = (error: unknown): void => {
    if (this.#disposed || this.#stopping) return;
    this.#failBoot('EMULATOR_ERROR', `The emulator failed: ${describeError(error)}`);
  };

  readonly #onEmulatorStopped = (): void => {
    // Echo of a deliberate stop.
    if (this.#disposed || this.#stopping) return;
    // Spontaneous stop: publish `stopped` so the lifecycle can reconcile.
    this.#signalStopped();
    void this.#cleanup();
  };

  #cleanup(): Promise<void> {
    if (this.#cleanupPromise !== null) return this.#cleanupPromise;
    this.#cleanupPromise = (async () => {
      this.#clearReadyTimeout();
      this.#removeListeners();
      this.#detachScroll?.();
      this.#detachScroll = null;
      this.#unsubscribeNetwork?.();
      this.#unsubscribeNetwork = null;
      this.#detachNetwork?.();
      this.#detachNetwork = null;
      try {
        await this.#emulator.stop();
      } catch (error) {
        this.#onCleanupError?.(error);
      }
      try {
        await this.#emulator.destroy();
      } catch (error) {
        this.#onCleanupError?.(error);
      }
      this.#console.detach();
      if (this.#network !== undefined) {
        try {
          await this.#network.dispose();
        } catch (error) {
          this.#onCleanupError?.(error);
        }
      }
    })();
    return this.#cleanupPromise;
  }

  #removeListeners(): void {
    const emulator = this.#emulator;
    emulator.remove_listener('emulator-ready', this.#onEmulatorReady);
    emulator.remove_listener('emulator-stopped', this.#onEmulatorStopped);
    emulator.remove_listener('download-progress', this.#onDownloadProgress);
    emulator.remove_listener('download-error', this.#onDownloadError);
    this.#errorBus.remove_listener('emulator-error', this.#onEmulatorError);
    if (this.#detector.mode === 'disk-boot') {
      emulator.remove_listener('ide-read-end', this.#onDiskRead);
    } else if (this.#detector.channel === 'vga') {
      emulator.remove_listener('screen-put-char', this.#onScreenChar);
    } else {
      emulator.remove_listener('serial0-output-byte', this.#onSerialByte);
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
