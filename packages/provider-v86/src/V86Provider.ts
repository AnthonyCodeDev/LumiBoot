import type { OSDefinition } from '@lumiboot/contracts';
import {
  VMError,
  type VMConfiguration,
  type VMCapabilities,
  type VMEngine,
  type VMInstance,
} from '@lumiboot/vm-core';
import { ensureImageManifest, type ImageManifest } from '@lumiboot/vm-assets';
import type { V86Options } from 'v86';
import { createBrowserV86, type V86Factory } from './browser-v86';
import { DomConsoleAdapter, type V86ConsoleAdapter } from './console-adapter';
import { V86Instance } from './v86-instance';

export const V86_PROVIDER_ID = 'v86';

const MiB = 1024 * 1024;

/** Emplacements statiques des binaires du moteur, préparés hors dépôt. */
export const V86_ASSET_PATHS = {
  wasm: '/v86/v86.wasm',
  bios: '/v86/seabios.bin',
  vgaBios: '/v86/vgabios.bin',
} as const;

/**
 * Ligne de commande du noyau : console série 115200 pour la console
 * interactive, `root=/dev/sda` correspond au disque `hda` transmis à v86.
 */
export const DEFAULT_BOOT_CMDLINE = 'console=tty0 console=ttyS0,115200 root=/dev/sda rw';

const V86_CAPABILITIES: VMCapabilities = {
  runtime: 'browser',
  architectures: ['i386'],
  ramSnapshots: true,
  diskSnapshots: true,
  // v86 lit le disque par requêtes HTTP Range (`hda.async`).
  partialDownload: true,
  resumable: false,
  configurableMemory: true,
};

export interface V86ProviderOptions {
  /** Factory d'instance v86 (réelle par défaut, injectable en test). */
  createEngine?: V86Factory;
  /** Résolution du manifeste d'image (`ensureImageManifest` par défaut). */
  resolveManifest?: (ref: string, signal?: AbortSignal) => Promise<ImageManifest>;
  /** Fabrique d'adaptateur de console (VGA + série), injectable en test. */
  createConsole?: () => V86ConsoleAdapter;
}

/**
 * Moteur navigateur x86 32 bits adossé à v86.
 *
 * Toute la connaissance de v86 reste confinée ici : l'UI ne voit qu'un
 * `VMInstance`. L'instance n'est créée qu'au lancement d'une session, et le
 * noyau invité n'est jamais considéré opérationnel avant l'émission du
 * marqueur `LUMIBOOT_GUEST_READY` sur `ttyS0`.
 */
export class V86Provider implements VMEngine {
  readonly id = V86_PROVIDER_ID;
  readonly #createEngine: V86Factory;
  readonly #resolveManifest: (ref: string, signal?: AbortSignal) => Promise<ImageManifest>;
  readonly #createConsole: () => V86ConsoleAdapter;

  constructor(options: V86ProviderOptions = {}) {
    this.#createEngine = options.createEngine ?? ((config) => createBrowserV86(config));
    this.#resolveManifest =
      options.resolveManifest ?? ((ref, signal) => ensureImageManifest(ref, signal));
    this.#createConsole = options.createConsole ?? (() => new DomConsoleAdapter());
  }

  capabilities(): VMCapabilities {
    return V86_CAPABILITIES;
  }

  canRun(os: OSDefinition): boolean {
    return os.launchProfiles.some(
      (profile) => profile.engineId === 'v86' && profile.executionMode === 'browser',
    );
  }

  async start(
    os: OSDefinition,
    mountTarget: unknown,
    configuration?: VMConfiguration,
  ): Promise<VMInstance> {
    if (typeof HTMLElement === 'undefined' || !(mountTarget instanceof HTMLElement)) {
      throw new VMError('START_FAILED', 'Cible de montage invalide pour la console v86.', {
        systemId: os.id,
      });
    }

    const launchProfile = os.launchProfiles.find(
      (profile) => profile.engineId === 'v86' && profile.executionMode === 'browser',
    );
    if (!launchProfile) {
      throw new VMError(
        'ENGINE_NOT_INTEGRATED',
        `Le moteur « v86 » n'est pas intégré pour « ${os.id} ».`,
        { systemId: os.id },
      );
    }
    if (!os.imageRef) {
      throw new VMError('IMAGE_MISSING', `Aucune image n'est associée à « ${os.id} ».`, {
        systemId: os.id,
      });
    }

    const signal = configuration?.signal;
    if (signal?.aborted) {
      throw new VMError('START_FAILED', `Démarrage annulé pour « ${os.id} ».`, {
        systemId: os.id,
      });
    }

    const manifest = await this.#loadManifest(os, signal);
    const disk = manifest.files['disk'];
    const bzimage = manifest.files['bzimage'];
    const initrd = manifest.files['initrd'];
    if (!disk || !bzimage || !initrd) {
      throw new VMError(
        'IMAGE_MISSING',
        `Le manifeste « ${manifest.ref} » ne contient pas les fichiers disk/bzimage/initrd requis.`,
        { systemId: os.id },
      );
    }

    const memoryMiB = resolveMemoryMiB(manifest, launchProfile.configuration, configuration);
    assertPowerOfTwoMiB(memoryMiB, 'memory_size', os.id);
    const vgaMemoryMiB =
      configuration?.vgaMemoryMiB ??
      launchProfile.configuration?.vgaMemoryMiB ??
      manifest.vgaMemoryMiB ??
      8;

    const consoleAdapter = this.#createConsole();
    const mounted = consoleAdapter.attach(mountTarget);

    const bootOptions = manifest.boot ?? {};
    const options: V86Options = {
      wasm_path: bootOptions.wasmPath ?? V86_ASSET_PATHS.wasm,
      bios: { url: bootOptions.biosUrl ?? V86_ASSET_PATHS.bios },
      vga_bios: { url: bootOptions.vgaBiosUrl ?? V86_ASSET_PATHS.vgaBios },
      memory_size: memoryMiB * MiB,
      vga_memory_size: vgaMemoryMiB * MiB,
      bzimage: { url: bzimage.url },
      initrd: { url: initrd.url },
      cmdline: bootOptions.cmdline ?? DEFAULT_BOOT_CMDLINE,
      hda: { url: disk.url, async: true, size: disk.size },
      screen: { container: mounted.screenContainer },
      serial_console: { type: 'textarea', container: mounted.serialTextarea },
      autostart: false,
    };

    let emulator: Awaited<ReturnType<V86Factory>>;
    try {
      emulator = await this.#createEngine(options);
    } catch (error) {
      consoleAdapter.detach();
      throw new VMError('START_FAILED', `Le moteur v86 n'a pas pu s'initialiser pour « ${os.id} ».`, {
        systemId: os.id,
        cause: error,
      });
    }

    if (signal?.aborted) {
      try {
        await emulator.destroy();
      } catch {
        /* nettoyage best-effort */
      }
      consoleAdapter.detach();
      throw new VMError('START_FAILED', `Démarrage annulé pour « ${os.id} ».`, {
        systemId: os.id,
      });
    }

    const instance = new V86Instance({
      providerId: this.id,
      systemId: os.id,
      emulator,
      console: consoleAdapter,
    });
    instance.wire();
    return instance;
  }

  async #loadManifest(os: OSDefinition, signal: AbortSignal | undefined): Promise<ImageManifest> {
    const ref = os.imageRef;
    if (!ref) {
      throw new VMError('IMAGE_MISSING', `Aucune image n'est associée à « ${os.id} ».`, {
        systemId: os.id,
      });
    }
    try {
      return await this.#resolveManifest(ref, signal);
    } catch (error) {
      if (error instanceof VMError) throw error;
      throw new VMError('IMAGE_MISSING', `Image « ${ref} » indisponible.`, {
        systemId: os.id,
        cause: error,
      });
    }
  }
}

interface MemoryHint {
  readonly memoryMiB?: number | undefined;
}

function resolveMemoryMiB(
  manifest: ImageManifest,
  profileConfiguration: MemoryHint | undefined,
  runtimeConfiguration: MemoryHint | undefined,
): number {
  return runtimeConfiguration?.memoryMiB ?? profileConfiguration?.memoryMiB ?? manifest.memoryMiB;
}

function assertPowerOfTwoMiB(value: number, label: string, systemId: string): void {
  const isPowerOfTwo = Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
  if (!isPowerOfTwo) {
    throw new VMError(
      'START_FAILED',
      `« ${label} » doit être une puissance de deux (reçu : ${value} MiB).`,
      { systemId },
    );
  }
}
