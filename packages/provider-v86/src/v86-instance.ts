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
  /** Preuve de démarrage attendue (marqueur + canal + délai) issue du profil. */
  readonly readiness: GuestReadiness;
  readonly id?: string;
  readonly onCleanupError?: (error: unknown) => void;
  /** Contrôleur réseau optionnel : ses diagnostics sont relayés en événements. */
  readonly network?: NetworkController;
}

/**
 * Instance de session adossée à un émulateur v86 unique.
 *
 * Garanties :
 * - les événements émis avant le premier `subscribe()` sont mémorisés puis
 *   rejoués dans l'ordre (aucune perte de la phase `booting`) ;
 * - `stop()` / `dispose()` sont idempotents et partagent une même promesse de
 *   nettoyage, même si `destroy()` rejette ;
 * - `running` n'est émis qu'une seule fois, sur preuve du marqueur invité ;
 * - aucun événement tardif (`running`, `stopped`) n'est émis après `dispose()`.
 */
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

  /** Branche les écouteurs v86. À appeler immédiatement après construction. */
  wire(): void {
    const emulator = this.#emulator;
    emulator.add_listener('emulator-ready', this.#onEmulatorReady);
    emulator.add_listener('emulator-stopped', this.#onEmulatorStopped);
    emulator.add_listener('download-progress', this.#onDownloadProgress);
    emulator.add_listener('download-error', this.#onDownloadError);
    // Le mode de preuve vient du profil : marqueur invité (série/VGA) ou
    // démarrage disque réel pour un média importé.
    if (this.#detector.mode === 'disk-boot') {
      emulator.add_listener('ide-read-end', this.#onDiskRead);
    } else if (this.#detector.channel === 'vga') {
      emulator.add_listener('screen-put-char', this.#onScreenChar);
    } else {
      emulator.add_listener('serial0-output-byte', this.#onSerialByte);
    }
    this.#wireNetwork();
    // Molette -> Shift+PageUp/PageDown (scrollback console Linux en mode texte).
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
    // État initial rejoué au premier abonné, même sans changement ultérieur.
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
    if (!this.#stopSignalled) {
      this.#stopSignalled = true;
      this.#emit({ type: 'state', state: 'stopped' });
    }
  }

  async dispose(): Promise<void> {
    this.#stopping = true;
    await this.#cleanup();
    this.#disposed = true;
    this.#listeners.clear();
    this.#pending = [];
  }

  #emit(event: SessionEvent): void {
    if (this.#disposed) return;
    if (!this.#hasSubscriber) {
      this.#pending.push(event);
      return;
    }
    for (const listener of this.#listeners) listener(event);
  }

  readonly #onEmulatorReady = (): void => {
    if (this.#disposed || this.#stopping) return;
    // L'émulateur (WASM) est prêt : le noyau invité COMMENCE à démarrer.
    this.#emit({ type: 'progress', phase: 'booting' });
    this.#armReadyTimeout();
    void this.#emulator.run().catch((error: unknown) => {
      this.#failBoot(
        'START_FAILED',
        `Le noyau invité n'a pas pu démarrer : ${describeError(error)}`,
      );
    });
  };

  /**
   * Arme le délai d'attente du marqueur, issu de `readiness.timeoutMs`. Le
   * marqueur reste l'unique preuve d'un démarrage réel : un délai dépassé est
   * donc un échec, jamais un faux `running`.
   */
  #armReadyTimeout(): void {
    if (this.#readyTimer !== null) return;
    this.#readyTimer = setTimeout(() => {
      this.#readyTimer = null;
      if (this.#disposed || this.#stopping || this.#detector.detected) return;
      this.#failBoot(
        'GUEST_READY_TIMEOUT',
        `Le marqueur de disponibilité « ${this.#detector.marker} » n'a pas été détecté dans le délai imparti.`,
      );
    }, this.#detector.timeoutMs);
  }

  #clearReadyTimeout(): void {
    if (this.#readyTimer === null) return;
    clearTimeout(this.#readyTimer);
    this.#readyTimer = null;
  }

  /**
   * Échec fatal d'amorçage : publie l'erreur puis libère immédiatement les
   * ressources (listeners v86/réseau, émulateur, **et** `NetworkController`).
   *
   * On appelle `#cleanup()` plutôt que `dispose()` pour ne pas effacer les
   * événements en attente de rejeu : un abonné tardif voit toujours l'erreur.
   * Le nettoyage reste idempotent (`#cleanupPromise` partagée), donc un
   * `stop()`/`dispose()` ultérieur de l'hôte est sans effet supplémentaire.
   */
  #failBoot(code: string, message: string): void {
    this.#emit({ type: 'error', code, message });
    void this.#cleanup();
  }

  readonly #onSerialByte = (byte: number): void => {
    if (this.#disposed || this.#stopping) return;
    if (this.#detector.pushByte(byte)) {
      this.#clearReadyTimeout();
      this.#emit({ type: 'state', state: 'running' });
    }
  };

  /** Canal VGA : la preuve est lue sur la sortie texte de l'écran. */
  readonly #onScreenChar = (arg: V86Event['screen-put-char']): void => {
    if (this.#disposed || this.#stopping) return;
    if (this.#detector.pushByte(arg[2])) {
      this.#clearReadyTimeout();
      this.#emit({ type: 'state', state: 'running' });
    }
  };

  /**
   * Mode `disk-boot` : la preuve est la première lecture réelle du disque dur
   * (`hda`, canal 0) après le démarrage de l'émulateur. Un média non amorçable
   * n'en produit pas ; aucun état `running` n'est donc simulé. Ce signal prouve
   * l'exécution de l'amorce invitée, pas que l'OS est pleinement opérationnel
   * (voir docs/windows-7.md).
   */
  readonly #onDiskRead = (arg: V86Event['ide-read-end']): void => {
    if (this.#disposed || this.#stopping) return;
    const [channelNr, byteCount] = arg;
    if (channelNr !== 0 || byteCount <= 0) return;
    if (this.#detector.markDiskBoot()) {
      this.#clearReadyTimeout();
      this.#emit({ type: 'state', state: 'running' });
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
    // Un téléchargement d'artefact raté est fatal : même libération que pour
    // une erreur de `run()` (aucune ressource ne doit rester orpheline).
    this.#failBoot(
      'ASSET_DOWNLOAD_FAILED',
      `Échec du chargement de l'artefact « ${arg.file_name} ».`,
    );
  };

  readonly #onEmulatorStopped = (): void => {
    // Un arrêt volontaire est déjà signalé par `stop()` ; on ignore l'écho.
    if (this.#disposed || this.#stopping) return;
    this.#emit({ type: 'state', state: 'stopped' });
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
