import { DEFAULT_GUEST_READINESS, type OSDefinition, type VMMedia } from '@lumiboot/contracts';
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
import {
  ensureImageManifest,
  ensureLocalDiskManifest,
  type ImageManifest,
  type LocalDiskManifest,
} from '@lumiboot/vm-assets';
import type { BootOrder, V86Options } from 'v86';
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

/**
 * Valeurs de `BootOrder` (v86) dont on a besoin, dupliquées en nombre pour ne
 * JAMAIS importer `v86` au chargement du provider (le moteur reste chargé
 * paresseusement par `browser-v86`). `CD_HARDDISK_FLOPPY = 0x123` démarre le
 * CD-ROM en premier, puis le disque dur.
 */
const BOOT_ORDER_CD_HARDDISK_FLOPPY = 0x123 as BootOrder;

/**
 * Capacités RÉELLES du moteur. `VMInstance` n'expose aucun point d'entrée de
 * snapshot (RAM ou disque) : le provider ne doit donc jamais annoncer
 * `ramSnapshots`/`diskSnapshots`, même si la classe `V86` possède un
 * `save_state`/`restore_state` interne non câblé au contrat. Annoncer une
 * capacité absente de `VMInstance` ferait promettre à l'UI une fonction qui
 * n'existe pas.
 */
const V86_CAPABILITIES: VMCapabilities = {
  runtime: 'browser',
  architectures: ['i386'],
  ramSnapshots: false,
  diskSnapshots: false,
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
  /**
   * Résolution du manifeste d'un disque local démarré par BIOS
   * (`ensureLocalDiskManifest` par défaut).
   */
  resolveDiskManifest?: (ref: string, signal?: AbortSignal) => Promise<LocalDiskManifest>;
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
  readonly #resolveDiskManifest: (ref: string, signal?: AbortSignal) => Promise<LocalDiskManifest>;
  readonly #createConsole: () => V86ConsoleAdapter;

  constructor(options: V86ProviderOptions = {}) {
    this.#createEngine = options.createEngine ?? ((config) => createBrowserV86(config));
    this.#resolveManifest =
      options.resolveManifest ?? ((ref, signal) => ensureImageManifest(ref, signal));
    this.#resolveDiskManifest =
      options.resolveDiskManifest ?? ((ref, signal) => ensureLocalDiskManifest(ref, signal));
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

    // Un profil `disk-boot` démarre un disque dur par BIOS (aucun noyau Linux) :
    // soit un disque RAW de la codebase (ex. Windows 7), soit un média importé
    // localement. Un profil `guest-marker` démarre une image publiée par noyau.
    const isDiskBoot = launchProfile.readiness?.mode === 'disk-boot';

    // Média importé par l'utilisateur : démarrage BIOS direct. LumiBoot ne
    // distribue AUCUN média propriétaire : il doit avoir été fourni localement.
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
    let diskManifest: LocalDiskManifest | null = null;
    if (media === undefined) {
      if (!os.imageRef) {
        throw new VMError('IMAGE_MISSING', `Aucune image n'est associée à « ${os.id} ».`, {
          systemId: os.id,
        });
      }
      if (isDiskBoot) {
        // Disque RAW local de la codebase : démarré par BIOS via HTTP Range.
        diskManifest = await this.#loadDiskManifest(os, signal);
      } else {
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
    }

    const memoryMiB = resolveMemoryMiB(
      manifest?.memoryMiB ?? diskManifest?.memoryMiB,
      launchProfile.configuration,
      configuration,
    );
    assertSupportedMemoryMiB(memoryMiB, 'memory_size', os.id);
    const vgaMemoryMiB =
      configuration?.vgaMemoryMiB ??
      launchProfile.configuration?.vgaMemoryMiB ??
      manifest?.vgaMemoryMiB ??
      diskManifest?.vgaMemoryMiB ??
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
    // Plans de démarrage réels :
    // - média importé RAW -> BIOS + disque (`hda`), aucun noyau Linux ;
    // - média importé ISO -> BIOS + CD-ROM (`cdrom`) + ordre de boot CD d'abord ;
    // - disque RAW local -> BIOS + disque (`hda`), aucun noyau Linux ;
    // - image publiée -> boot direct du noyau (`bzimage`/`initrd` + `hda`).
    //
    // Un disque RAW est lu en lecture seule via des requêtes Range (`async`) : la
    // base n'est jamais réécrite, les écritures invitées restent dans le tampon
    // mémoire et disparaissent à l'arrêt (aucune persistance revendiquée, voir
    // docs/windows-7.md). Une ISO est un média optique : elle n'est JAMAIS montée
    // comme disque dur.
    const bootMedia: V86Options = media
      ? resolveMediaBootOptions(media, launchProfile, configuration, os.id)
      : diskManifest
        ? {
            hda: {
              url: diskManifest.boot.url,
              async: true,
              size: diskManifest.disk.size,
            },
          }
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
      // Une session à média importé OU à disque local en a besoin.
      ...(media === undefined && diskManifest === null
        ? {}
        : { acpi: launchProfile.hardwareProfile?.acpi ?? false }),
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

  async #loadDiskManifest(
    os: OSDefinition,
    signal: AbortSignal | undefined,
  ): Promise<LocalDiskManifest> {
    const ref = os.imageRef;
    if (!ref) {
      throw new VMError('IMAGE_MISSING', `Aucun disque n'est associé à « ${os.id} ».`, {
        systemId: os.id,
      });
    }
    try {
      return await this.#resolveDiskManifest(ref, signal);
    } catch (error) {
      if (error instanceof VMError) throw error;
      throw new VMError('IMAGE_MISSING', `Disque « ${ref} » indisponible.`, {
        systemId: os.id,
        cause: error,
      });
    }
  }
}

/** Mémoire par défaut si aucun niveau ne la fournit. */
const DEFAULT_MEMORY_MIB = 512;

interface MemoryHint {
  readonly memoryMiB?: number | undefined;
}

function resolveMemoryMiB(
  manifestMemoryMiB: number | undefined,
  profileConfiguration: MemoryHint | undefined,
  runtimeConfiguration: MemoryHint | undefined,
): number {
  return (
    runtimeConfiguration?.memoryMiB ??
    profileConfiguration?.memoryMiB ??
    manifestMemoryMiB ??
    DEFAULT_MEMORY_MIB
  );
}

/**
 * Valide la mémoire invitée selon les contraintes RÉELLES de v86 0.5.471 :
 * un entier de Mio strictement positif dont la taille en octets tient dans un
 * entier signé 32 bits (`0x7FFFFFFF`, soit 2047 Mio). v86 arrondit
 * `create_memory` à un multiple de 128 Kio et clampe au-delà de 2 Gio : une
 * puissance de deux n'est PAS requise. 1536 Mio est donc valide et accepté.
 */
function assertSupportedMemoryMiB(value: number, label: string, systemId: string): void {
  const supported = Number.isInteger(value) && value > 0 && value * MiB <= 0x7fffffff;
  if (!supported) {
    throw new VMError(
      'START_FAILED',
      `« ${label} » doit être un entier de Mio <= 2047 (reçu : ${value} MiB).`,
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

/**
 * Traduit un média importé par l'utilisateur en options v86, selon son format :
 *
 * - `raw` : disque dur (`hda`), lu en lecture seule via requêtes Range (`async`).
 * - `iso` : média optique monté en CD-ROM (`cdrom`) avec un ordre de boot
 *   privilégiant le CD.
 *
 * L'installation d'un OS sur un disque vierge n'est PAS supportée : LumiBoot ne
 * fournit aucun disque inscriptible persistant et v86 écrit en mémoire (perdu à
 * l'arrêt). Une ISO destinée à l'installation est donc refusée par une
 * `VMError` explicite (`UNSUPPORTED_ENVIRONMENT`) plutôt que de simuler une
 * persistance. Seule une ISO amorçable « live » (profil non `disk-boot` et
 * `bootDevice: 'cdrom'`) est acceptée.
 */
function resolveMediaBootOptions(
  media: VMMedia,
  launchProfile: OSDefinition['launchProfiles'][number],
  configuration: VMConfiguration | undefined,
  systemId: string,
): V86Options {
  if (media.format === 'raw') {
    return { hda: { url: media.url, async: true, size: media.size } };
  }

  const bootTarget = configuration?.bootDevice ?? launchProfile.configuration?.bootDevice;
  const installsToDisk = launchProfile.readiness?.mode === 'disk-boot' || bootTarget === 'disk';
  if (installsToDisk) {
    throw new VMError(
      'UNSUPPORTED_ENVIRONMENT',
      'Installation sur disque vierge non supportée : LumiBoot ne monte aucun disque ' +
        'inscriptible et ne persiste aucune écriture (v86 écrit en mémoire, perdu à l’arrêt). ' +
        'Fournissez un disque déjà installé au format RAW au lieu d’une ISO d’installation.',
      { systemId },
    );
  }

  return {
    cdrom: { url: media.url, async: true, size: media.size },
    boot_order: BOOT_ORDER_CD_HARDDISK_FLOPPY,
  };
}
