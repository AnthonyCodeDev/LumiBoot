import type {
  EngineId,
  ExecutionMode,
  GuestReadiness,
  HardwareProfile,
  VMConfiguration,
} from '@lumiboot/contracts';

/**
 * Description factuelle d'un profil de lancement (image + moteur + paramètres).
 *
 * Ce fichier ne déclare AUCUN statut de disponibilité : la disponibilité est
 * calculée une seule fois, dans `systems.ts`. `validated` atteste uniquement
 * qu'un boot réel a été prouvé pour ce couple image/moteur.
 *
 * `hardwareProfile` décrit le matériel émulé vu par l'invité (indépendant du
 * moteur) et `readiness` la preuve de démarrage attendue : ils sont portés par
 * le PROFIL afin que le provider n'ait plus à les deviner par famille/arch.
 */
export interface LaunchProfileDefinition {
  readonly id: string;
  readonly imageId: string;
  readonly engineId: EngineId;
  readonly executionMode: ExecutionMode;
  readonly minMemoryMiB: number;
  readonly configuration?: VMConfiguration;
  readonly hardwareProfile: HardwareProfile;
  readonly readiness: GuestReadiness;
  readonly slug: string;
  readonly displayName: string;
  readonly versionLabel: string;
  readonly description: string;
  /** Boot réel prouvé pour ce profil (tests E2E). */
  readonly validated: boolean;
  readonly featured?: boolean;
}

/**
 * Matériel émulé commun aux invités PC de ce catalogue : machine standard,
 * VGA, entrée PS/2, disque IDE/ATA, sans son. Seule la carte réseau varie.
 */
function pcHardware(network: HardwareProfile['network']): HardwareProfile {
  return { network, machine: 'pc', video: 'vga', input: 'ps2', disk: 'ide', audio: false };
}

/**
 * Preuve de démarrage propre à un système : le marqueur reste celui émis par
 * `lumiboot-ready.service` sur `ttyS0` (canal série), avec un délai de sécurité
 * de 120 s.
 */
function guestReadiness(systemId: string): GuestReadiness {
  return {
    marker: `LUMIBOOT_GUEST_READY:${systemId}`,
    channel: 'serial',
    timeoutMs: 120_000,
  };
}

/**
 * Preuve de démarrage d'un système à interface graphique.
 *
 * Le marqueur `LUMIBOOT_DESKTOP_READY` n'est émis qu'APRÈS le démarrage effectif
 * du serveur X (socket + réponse) ET de la session graphique (gestionnaire de
 * fenêtres vivant). Il est distinct de `LUMIBOOT_GUEST_READY` (OS opérationnel)
 * et n'est jamais produit côté JavaScript : il vient du système invité réel.
 */
function desktopReadiness(systemId: string): GuestReadiness {
  return {
    marker: `LUMIBOOT_DESKTOP_READY:${systemId}`,
    channel: 'serial',
    // Délai normal : sous émulation logicielle (v86 sans accélération), Xorg et
    // la session graphique demandent plusieurs minutes ; 240 s couvre les
    // boots mesurés (voir docs/debian-desktop.md, docs/debian-xfce.md).
    timeoutMs: 240_000,
  };
}

/**
 * Preuve de démarrage d'un système à média importé (ex. Windows 7).
 *
 * Ce système n'émet AUCUN marqueur LumiBoot. La preuve est une **lecture réelle
 * du disque dur** après le démarrage de l'émulateur (le BIOS/l'amorce exécute
 * l'image fournie par l'utilisateur). `marker` sert d'identifiant documentaire
 * et n'est jamais scanné. Le délai est large : le POST, l'amorce et le chargement
 * NT prennent plusieurs minutes sous émulation logicielle.
 */
function diskBootReadiness(systemId: string): GuestReadiness {
  return {
    marker: `LUMIBOOT_DISK_BOOT:${systemId}`,
    mode: 'disk-boot',
    channel: 'vga',
    timeoutMs: 300_000,
  };
}

export const launchProfiles = [
  {
    id: 'debian-12-i386',
    imageId: 'debian-12-i386-image',
    engineId: 'v86',
    executionMode: 'browser',
    minMemoryMiB: 128,
    // Le choix du moteur et les paramètres d'exécution vivent dans le PROFIL,
    // jamais dans l'image : un même disque Debian peut ainsi être associé à
    // plusieurs profils (v86, puis un autre émulateur) sans dupliquer l'image.
    configuration: {
      memoryMiB: 512,
      vgaMemoryMiB: 16,
      bootDevice: 'disk',
    },
    // Noyau 6.x : `virtio-net` natif, marqueur conservé tel quel.
    hardwareProfile: pcHardware('virtio'),
    readiness: guestReadiness('debian-12-i386'),
    slug: 'debian-12-i386',
    displayName: 'Debian',
    versionLabel: '12 Bookworm',
    validated: true,
    featured: true,
    description:
      "Une distribution Linux stable, flexible et idéale pour découvrir un véritable système d'exploitation en navigateur.",
  },
  {
    id: 'debian-12-i386-desktop',
    imageId: 'debian-12-i386-desktop-image',
    engineId: 'v86',
    executionMode: 'browser',
    // Xorg + Openbox consomment plus de mémoire que la console : plancher 1 Gio.
    minMemoryMiB: 1024,
    configuration: {
      memoryMiB: 1024,
      vgaMemoryMiB: 16,
      bootDevice: 'disk',
    },
    // Même carte réseau émulée que le profil console (noyau 6.x, `virtio-net`).
    hardwareProfile: pcHardware('virtio'),
    // Le marqueur Desktop n'est émis qu'après le démarrage réel de X + session.
    readiness: desktopReadiness('debian-12-i386-desktop'),
    slug: 'debian-12-i386-desktop',
    displayName: 'Debian (Bureau)',
    versionLabel: '12 Bookworm · X11',
    // Validé par un boot RÉEL (Xorg + Openbox) : voir docs/debian-desktop.md.
    validated: true,
    description:
      'La variante graphique de Debian 12 : session Xorg + Openbox directement dans le navigateur, validée par un boot réel.',
  },
  {
    id: 'debian-12-i386-xfce',
    imageId: 'debian-12-i386-xfce-image',
    engineId: 'v86',
    executionMode: 'browser',
    // Xorg + session XFCE consomment plus de mémoire que la console : plancher 1 Gio.
    minMemoryMiB: 1024,
    configuration: {
      memoryMiB: 1024,
      vgaMemoryMiB: 16,
      bootDevice: 'disk',
    },
    // Même carte réseau émulée que les autres profils Debian (noyau 6.x, `virtio-net`).
    hardwareProfile: pcHardware('virtio'),
    // Le marqueur Desktop n'est émis qu'après le démarrage réel de X + session XFCE.
    readiness: desktopReadiness('debian-12-i386-xfce'),
    slug: 'debian-12-i386-xfce',
    displayName: 'Debian (XFCE)',
    versionLabel: '12 Bookworm · XFCE',
    // Validé par un boot RÉEL (Xorg + session XFCE) : voir docs/debian-xfce.md.
    validated: true,
    description:
      "La variante Debian 12 avec l'environnement de bureau complet XFCE : session Xorg + XFCE directement dans le navigateur, validée par un boot réel.",
  },
  {
    id: 'ubuntu-18-i386',
    imageId: 'ubuntu-18-i386-image',
    engineId: 'v86',
    executionMode: 'browser',
    minMemoryMiB: 256,
    configuration: {
      memoryMiB: 1024,
      vgaMemoryMiB: 16,
      bootDevice: 'cdrom',
    },
    // Noyau 4.15 : `virtio-net` natif.
    hardwareProfile: pcHardware('virtio'),
    readiness: guestReadiness('ubuntu-18-i386'),
    slug: 'ubuntu-18-i386',
    displayName: 'Ubuntu',
    versionLabel: '18.04 LTS',
    validated: false,
    description:
      'Une version 32 bits historique d’Ubuntu envisageable avec un émulateur x86 en navigateur.',
  },
  {
    id: 'fedora-workstation',
    imageId: 'fedora-workstation-image',
    engineId: 'wasm-x86_64',
    executionMode: 'browser',
    minMemoryMiB: 4096,
    configuration: {
      memoryMiB: 4096,
      bootDevice: 'disk',
    },
    hardwareProfile: pcHardware('virtio'),
    readiness: guestReadiness('fedora-workstation'),
    slug: 'fedora-workstation',
    displayName: 'Fedora',
    versionLabel: 'Workstation · x64',
    validated: false,
    description: 'Un environnement Linux de bureau moderne prévu pour un moteur navigateur adapté.',
  },
  {
    id: 'mint-x64',
    imageId: 'mint-x64-image',
    engineId: 'wasm-x86_64',
    executionMode: 'browser',
    minMemoryMiB: 4096,
    configuration: {
      memoryMiB: 4096,
      bootDevice: 'disk',
    },
    hardwareProfile: pcHardware('virtio'),
    readiness: guestReadiness('mint-x64'),
    slug: 'mint-x64',
    displayName: 'Linux Mint',
    versionLabel: 'Cinnamon · x64',
    validated: false,
    description: 'Un bureau Linux classique et accessible, à lancer dans le navigateur.',
  },
  {
    id: 'windows-7-x86',
    imageId: 'windows-7-x86-image',
    // v86 est le seul moteur navigateur x86 32 bits intégré : Windows 7 x86 est
    // donc réellement rattachable (démarrage BIOS d'un disque importé), sans
    // prétendre à un état « disponible » tant qu'aucun boot n'est validé.
    engineId: 'v86',
    executionMode: 'browser',
    // `memory_size` de v86 EXIGE une puissance de deux (assertPowerOfTwoMiB).
    // Le disque de référence a été préparé sous QEMU à 1536 Mio, valeur qui
    // n'est PAS un niveau v86 valide : 1024 Mio (plancher documenté par v86
    // pour Vista+) est retenu. Une valeur supérieure peut être demandée à
    // l'exécution (2048 Mio) sans changer le profil.
    minMemoryMiB: 1024,
    configuration: {
      memoryMiB: 1024,
      vgaMemoryMiB: 16,
      bootDevice: 'disk',
    },
    // Invité NT ancien : pilotes virtio absents, `ne2k` est le support commun.
    // v86 n'émule QUE `ne2k` ou `virtio` (`v86.d.ts` : `type?: "ne2k" | "virtio"`)
    // — e1000/rtl8139 ne sont pas disponibles. ACPI est requise par la famille
    // Vista+ (voir docs/windows-nt.md de v86 : « Enable ACPI and set the memory
    // size to 512 MB or more »).
    hardwareProfile: { ...pcHardware('ne2k'), acpi: true },
    // Média importé : le démarrage est prouvé par une lecture disque réelle.
    readiness: diskBootReadiness('windows-7-x86'),
    slug: 'windows-7-x86',
    displayName: 'Windows 7',
    versionLabel: 'Super Lite · x86',
    // Aucun boot Windows réel prouvé : reste non `ready`, même média importé.
    validated: false,
    description:
      'Une session Windows 7 x86 Super Lite dans le navigateur via v86, à partir d’un ' +
      'disque que vous détenez légalement. Aucun média n’est distribué : importez le vôtre.',
  },
  {
    id: 'windows-10-x64',
    imageId: 'windows-10-x64-image',
    engineId: 'wasm-x86_64',
    executionMode: 'browser',
    minMemoryMiB: 4096,
    configuration: {
      memoryMiB: 4096,
      bootDevice: 'disk',
    },
    hardwareProfile: pcHardware('virtio'),
    readiness: guestReadiness('windows-10-x64'),
    slug: 'windows-10-x64',
    displayName: 'Windows 10',
    versionLabel: '64 bits',
    validated: false,
    description: 'Une version moderne de Windows pensée pour un moteur navigateur adapté.',
  },
  {
    id: 'windows-11-x64',
    imageId: 'windows-11-x64-image',
    engineId: 'wasm-x86_64',
    executionMode: 'browser',
    minMemoryMiB: 4096,
    configuration: {
      memoryMiB: 4096,
      bootDevice: 'disk',
    },
    hardwareProfile: pcHardware('virtio'),
    readiness: guestReadiness('windows-11-x64'),
    slug: 'windows-11-x64',
    displayName: 'Windows 11',
    versionLabel: '64 bits',
    validated: false,
    description:
      'Une machine virtuelle Windows moderne pensée pour une exécution locale dans le navigateur.',
  },
  {
    id: 'macos-sequoia',
    imageId: 'macos-sequoia-image',
    engineId: 'wasm-arm',
    executionMode: 'browser',
    minMemoryMiB: 8192,
    configuration: {
      memoryMiB: 8192,
      bootDevice: 'disk',
    },
    hardwareProfile: pcHardware('virtio'),
    readiness: guestReadiness('macos-sequoia'),
    slug: 'macos-sequoia',
    displayName: 'macOS',
    versionLabel: 'Sequoia · Apple Silicon',
    validated: false,
    description: 'Une session macOS pensée pour un futur moteur navigateur compatible ARM.',
  },
] as const satisfies readonly LaunchProfileDefinition[];
