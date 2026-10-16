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
 * Phases internes de disponibilité d'une instance, strictement ordonnées :
 *
 * - `idle` : rien n'a encore été observé ;
 * - `emulator-ready` : le WASM de v86 est prêt, l'émulateur peut être lancé ;
 * - `booting` : le noyau/invité a commencé à démarrer (aucune preuve encore) ;
 * - `guest-ready` : la preuve déclarée par le profil est arrivée (marqueur
 *   invité ou lecture disque en `disk-boot`) ;
 * - `unverified` : le délai est échu sans preuve. L'état réel de l'invité reste
 *   NON vérifié : jamais `guest-ready`, jamais `running`.
 */
export type V86ReadinessStage =
  'idle' | 'emulator-ready' | 'booting' | 'guest-ready' | 'unverified';

/**
 * Phases de progression publiées. Elles distinguent explicitement les trois
 * signaux souvent confondus :
 * - `emulatorReady` : WASM chargé (rien de plus) ;
 * - `booting` : démarrage du noyau invité en cours ;
 * - `guestReady` : preuve invité forte (marqueur) ;
 * - `diskBoot` : preuve faible (lecture disque BIOS), jamais un marqueur invité ;
 * - `bootTimeout` : délai échu sans preuve, état non vérifié.
 */
export const V86_PROGRESS = {
  emulatorReady: 'emulator-ready',
  booting: 'booting',
  guestReady: 'guest-ready',
  diskBoot: 'disk-boot',
  bootTimeout: 'boot-timeout',
} as const;

/** Code d'erreur publié quand aucune preuve de démarrage n'arrive dans le délai. */
export const V86_BOOT_TIMEOUT_CODE = 'BOOT_TIMEOUT';

/**
 * Instance de session adossée à un émulateur v86 unique.
 *
 * Garanties :
 * - les événements émis avant le premier `subscribe()` sont mémorisés puis
 *   rejoués dans l'ordre (aucune perte de la phase `booting`) ;
 * - `stop()` / `dispose()` sont idempotents et partagent une même promesse de
 *   nettoyage, même si `destroy()` rejette ;
 * - `running` n'est émis qu'une seule fois, et UNIQUEMENT sur la preuve déclarée
 *   par le profil (marqueur invité, ou lecture disque en `disk-boot`). Le délai
 *   n'est jamais une preuve : son échéance publie `BOOT_TIMEOUT` et laisse
 *   l'invité NON vérifié, sans détruire l'écran ;
 * - un arrêt spontané de l'émulateur (`emulator-stopped`) publie un `stopped`
 *   réconciliable et libère les ressources de façon idempotente ;
 * - aucun événement tardif (`running`, `stopped`) n'est émis après `stop()` /
 *   `dispose()`.
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
  #runningEmitted = false;
  #bootFailed = false;
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

  /** Phase de disponibilité observée (voir {@link V86ReadinessStage}). */
  get readiness(): V86ReadinessStage {
    return this.#readinessStage;
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
    this.#signalStopped();
  }

  async dispose(): Promise<void> {
    this.#stopping = true;
    await this.#cleanup();
    this.#disposed = true;
    this.#listeners.clear();
    this.#pending = [];
  }

  /**
   * Publie l'arrêt une seule fois, sous la forme `stopping` puis `stopped`.
   *
   * Le cycle de vie (`SessionStateMachine`) n'autorise PAS la transition directe
   * `running -> stopped` : un arrêt spontané doit traverser `stopping` pour être
   * réconcilié. `#emit` neutralise tout envoi après `dispose()`, et le drapeau
   * partagé rend l'opération idempotente (stop volontaire, arrêt spontané,
   * `dispose()`). L'arrêt bloque aussi tout `running` tardif (`#stopping`).
   */
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

  /**
   * Émet `running` au plus une fois, UNIQUEMENT sur la preuve déclarée par le
   * profil. `proof` étiquette la transition (`guest-ready` pour un marqueur
   * invité, `disk-boot` pour une lecture disque) afin de ne jamais présenter une
   * activité BIOS comme un marqueur invité. Un échec de démarrage déjà publié
   * (`BOOT_TIMEOUT`) ou un arrêt neutralise toute émission tardive.
   */
  #emitRunning(proof: 'guest-marker' | 'disk-boot'): void {
    if (this.#runningEmitted || this.#bootFailed || this.#stopping || this.#disposed) return;
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
    // Étape 1 : le WASM de v86 est prêt. Cela ne prouve RIEN sur l'invité.
    this.#readinessStage = 'emulator-ready';
    this.#emit({ type: 'progress', phase: V86_PROGRESS.emulatorReady });
    // Étape 2 : on lance réellement l'émulateur ; le noyau invité DÉBUTE.
    this.#readinessStage = 'booting';
    this.#emit({ type: 'progress', phase: V86_PROGRESS.booting });
    this.#armReadyTimeout();
    void this.#emulator.run().catch((error: unknown) => {
      this.#failBoot(
        'START_FAILED',
        `Le noyau invité n'a pas pu démarrer : ${describeError(error)}`,
      );
    });
  };

  /**
   * Arme le délai d'attente de la preuve, issu de `readiness.timeoutMs`.
   *
   * La preuve reste le SEUL chemin vers `running`. À l'échéance sans preuve, on
   * publie un échec explicite `BOOT_TIMEOUT` : l'état de l'invité reste NON
   * vérifié et `running` n'est jamais simulé. On ne détruit ni l'émulateur ni la
   * console : l'écran reste visible et vivant pour le diagnostic.
   */
  #armReadyTimeout(): void {
    if (this.#readyTimer !== null) return;
    this.#readyTimer = setTimeout(() => {
      this.#readyTimer = null;
      if (this.#disposed || this.#stopping || this.#bootFailed || this.#detector.detected) {
        return;
      }
      this.#bootTimedOut();
    }, this.#detector.timeoutMs);
  }

  /**
   * Échéance du délai sans preuve. Publie `BOOT_TIMEOUT` et fige l'invité en
   * `unverified`. Aucun nettoyage : l'écran (VGA/série) doit rester affiché.
   * Toute preuve ultérieure est ignorée par `#emitRunning` (`#bootFailed`).
   */
  #bootTimedOut(): void {
    this.#bootFailed = true;
    this.#readinessStage = 'unverified';
    this.#emit({ type: 'progress', phase: V86_PROGRESS.bootTimeout });
    this.#emit({
      type: 'error',
      code: V86_BOOT_TIMEOUT_CODE,
      message: this.#describeBootTimeout(),
    });
  }

  #describeBootTimeout(): string {
    const seconds = Math.round(this.#detector.timeoutMs / 1000);
    return (
      `Preuve de démarrage absente après ${seconds} s : ` +
      `${this.#detector.describeExpectedProof()} n'a pas été observée. ` +
      'Le démarrage de l’invité reste NON vérifié (aucun état « running » simulé).'
    );
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
    if (this.#disposed || this.#stopping || this.#bootFailed) return;
    if (this.#detector.pushByte(byte)) {
      this.#emitRunning('guest-marker');
    }
  };

  /** Canal VGA : la preuve est lue sur la sortie texte de l'écran. */
  readonly #onScreenChar = (arg: V86Event['screen-put-char']): void => {
    if (this.#disposed || this.#stopping || this.#bootFailed) return;
    if (this.#detector.pushByte(arg[2])) {
      this.#emitRunning('guest-marker');
    }
  };

  /**
   * Mode `disk-boot` : la preuve est la première lecture réelle du disque dur
   * (`hda`, canal 0). C'est une preuve FAIBLE : une activité d'amorçage BIOS,
   * PAS un marqueur prouvant un OS opérationnel. Elle est étiquetée `disk-boot`
   * pour ne jamais passer pour une preuve invité. Un média non amorçable n'en
   * produit pas ; aucun `running` n'est alors simulé (voir `#bootTimedOut`).
   */
  readonly #onDiskRead = (arg: V86Event['ide-read-end']): void => {
    if (this.#disposed || this.#stopping || this.#bootFailed) return;
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
    // Arrêt spontané (extinction/crash invité) : on publie `stopped` pour que le
    // cycle de vie puisse réconcilier, puis on libère idempotemment (listeners,
    // émulateur, console, réseau). `#cleanup()` est partagé avec `stop()` /
    // `dispose()` : une seule libération effective.
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
