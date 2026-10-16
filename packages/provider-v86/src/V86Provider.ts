import { DEFAULT_GUEST_READINESS, type OSDefinition } from '@lumiboot/contracts';
import {
  VMError,
  isVMError,
  type VMConfiguration,
  type VMCapabilities,
  type VMEngine,
  type VMInstance,
} from '@lumiboot/vm-core';
import {
  createNetworkController,
  defaultNetworkProfile,
  isNetworkError,
} from '@lumiboot/vm-network';
import { ensureImageManifest, type ImageManifest } from '@lumiboot/vm-assets';
import type { V86Options } from 'v86';
import { createBrowserV86, type V86Factory } from './browser-v86';
import { DomConsoleAdapter, type V86ConsoleAdapter, type V86ConsoleMount } from './console-adapter';
import {
  toV86NetworkDevice,
  toV86NetworkDeviceType,
  type V86NetworkDevice,
} from './network/V86NetworkAdapter';
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

    const signal = configuration?.signal;
    if (signal?.aborted) {
      throw new VMError('START_FAILED', `Démarrage annulé pour « ${os.id} ».`, {
        systemId: os.id,
      });
    }

    // Média importé par l'utilisateur (ex. disque Windows 7 préinstallé) :
    // démarrage BIOS direct, sans noyau Linux. LumiBoot ne distribue AUCUN
    // média propriétaire : il doit avoir été fourni localement par l'utilisateur.
    const media = configuration?.media;
    if (os.mediaStrategy === 'user-import' && media === undefined) {
      throw new VMError(
        'MEDIA_REQUIRED',
        `« ${os.displayName} » nécessite un média disque fourni par l'utilisateur. ` +
          'Importez une image que vous détenez légalement pour démarrer la session.',
        { systemId: os.id },
      );
    }

    let manifest: ImageManifest | null = null;
    if (media === undefined) {
      if (!os.imageRef) {
        throw new VMError('IMAGE_MISSING', `Aucune image n'est associée à « ${os.id} ».`, {
          systemId: os.id,
        });
      }
      manifest = await this.#loadManifest(os, signal);
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
    }

    const memoryMiB = resolveMemoryMiB(manifest, launchProfile.configuration, configuration);
    assertPowerOfTwoMiB(memoryMiB, 'memory_size', os.id);
    const vgaMemoryMiB =
      configuration?.vgaMemoryMiB ??
      launchProfile.configuration?.vgaMemoryMiB ??
      manifest?.vgaMemoryMiB ??
      8;

    // Réseau fixé AVANT la construction de l'émulateur : changer d'interface
    // réseau exige un redémarrage complet de v86. Chaque session possède son
    // propre contrôleur (jamais partagé entre sessions).
    //
    // La carte émulée vient du PROFIL MATÉRIEL du catalogue : le provider ne
    // fait que traduire ce contrat (`network` -> `net_device.type`), jamais de
    // décision par système.
    const networkProfile = configuration?.network ?? defaultNetworkProfile;
    const networkController = createNetworkController({ profile: networkProfile });
    let netDevice: V86NetworkDevice | undefined;
    try {
      const transport = toV86NetworkDevice(networkProfile);
      const deviceType = toV86NetworkDeviceType(launchProfile.hardwareProfile);
      if (transport !== undefined && deviceType !== undefined) {
        netDevice = { ...transport, type: deviceType };
      }
      await networkController.start(signal);
    } catch (error) {
      await networkController.dispose().catch(() => undefined);
      throw toStartFailure(error, os.id);
    }

    const consoleAdapter = this.#createConsole();
    let mounted: V86ConsoleMount;
    try {
      mounted = consoleAdapter.attach(mountTarget);
    } catch (error) {
      // Le montage de console peut défaillir (DOM inattendu) : le contrôleur
      // réseau ne doit jamais survivre à un échec de démarrage.
      await networkController.dispose().catch(() => undefined);
      throw new VMError(
        'START_FAILED',
        `La console v86 n'a pas pu être montée pour « ${os.id} ».`,
        { systemId: os.id, cause: error },
      );
    }

    const bootOptions = manifest?.boot ?? {};
    const kernelDisk = manifest?.files['disk'];
    const bzimage = manifest?.files['bzimage'];
    const initrd = manifest?.files['initrd'];
    // Deux plans de démarrage réels :
    // - média importé -> BIOS + disque (`hda`), aucun noyau Linux ;
    // - image publiée -> boot direct du noyau (`bzimage`/`initrd` + `hda`).
    const bootMedia: V86Options = media
      ? { hda: { url: media.url, async: true, size: media.size } }
      : {
          bzimage: { url: bzimage!.url },
          initrd: { url: initrd!.url },
          cmdline: bootOptions.cmdline ?? DEFAULT_BOOT_CMDLINE,
          hda: { url: kernelDisk!.url, async: true, size: kernelDisk!.size },
        };
    const options: V86Options = {
      wasm_path: bootOptions.wasmPath ?? V86_ASSET_PATHS.wasm,
      bios: { url: bootOptions.biosUrl ?? V86_ASSET_PATHS.bios },
      vga_bios: { url: bootOptions.vgaBiosUrl ?? V86_ASSET_PATHS.vgaBios },
      memory_size: memoryMiB * MiB,
      vga_memory_size: vgaMemoryMiB * MiB,
      screen: { container: mounted.screenContainer },
      serial_console: { type: 'textarea', container: mounted.serialTextarea },
      autostart: false,
      ...bootMedia,
      // ACPI vient du profil matériel (requis par les invités NT modernes).
      ...(media === undefined ? {} : { acpi: launchProfile.hardwareProfile?.acpi ?? false }),
      ...(netDevice === undefined ? {} : { net_device: netDevice }),
    };

    let emulator: Awaited<ReturnType<V86Factory>>;
    try {
      emulator = await this.#createEngine(options);
    } catch (error) {
      consoleAdapter.detach();
      await networkController.dispose().catch(() => undefined);
      throw new VMError(
        'START_FAILED',
        `Le moteur v86 n'a pas pu s'initialiser pour « ${os.id} ».`,
        {
          systemId: os.id,
          cause: error,
        },
      );
    }

    if (signal?.aborted) {
      try {
        await emulator.destroy();
      } catch {
        /* nettoyage best-effort */
      }
      consoleAdapter.detach();
      await networkController.dispose().catch(() => undefined);
      throw new VMError('START_FAILED', `Démarrage annulé pour « ${os.id} ».`, {
        systemId: os.id,
      });
    }

    let instance: V86Instance;
    try {
      instance = new V86Instance({
        providerId: this.id,
        systemId: os.id,
        emulator,
        console: consoleAdapter,
        readiness: launchProfile.readiness ?? DEFAULT_GUEST_READINESS,
        network: networkController,
      });
      instance.wire();
    } catch (error) {
      // Dernier filet : si le câblage échoue, on détruit l'émulateur et on
      // libère le contrôleur réseau pour ne laisser aucune ressource orpheline.
      try {
        await emulator.destroy();
      } catch {
        /* nettoyage best-effort */
      }
      consoleAdapter.detach();
      await networkController.dispose().catch(() => undefined);
      throw new VMError(
        'START_FAILED',
        `La session v86 n'a pas pu être câblée pour « ${os.id} ».`,
        { systemId: os.id, cause: error },
      );
    }
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

/** Mémoire par défaut (puissance de deux) si aucun niveau ne la fournit. */
const DEFAULT_MEMORY_MIB = 512;

function resolveMemoryMiB(
  manifest: ImageManifest | null,
  profileConfiguration: MemoryHint | undefined,
  runtimeConfiguration: MemoryHint | undefined,
): number {
  return (
    runtimeConfiguration?.memoryMiB ??
    profileConfiguration?.memoryMiB ??
    manifest?.memoryMiB ??
    DEFAULT_MEMORY_MIB
  );
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

/**
 * Convertit toute défaillance de la couche réseau en `VMError` de démarrage :
 * un profil invalide (`user-relay` sans URL `wss://`, `local-network`) doit faire
 * échouer la session au démarrage, jamais silencieusement.
 */
function toStartFailure(error: unknown, systemId: string): VMError {
  if (isVMError(error)) return error;
  if (isNetworkError(error)) {
    return new VMError('START_FAILED', error.message, { systemId, cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new VMError('START_FAILED', `Le réseau n'a pas pu être initialisé : ${message}`, {
    systemId,
    cause: error,
  });
}
