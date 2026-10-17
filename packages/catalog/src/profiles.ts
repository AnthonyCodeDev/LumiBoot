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
  /**
   * Id du système « mère » de ce variant (absent = ce profil EST la mère ou un
   * système autonome). Recopié dans l'`OSDefinition` par `systems.ts`.
   */
  readonly variantGroupId?: string;
  /** Libellé court du variant (affiché dans un sélecteur côté fiche). */
  readonly variantName?: string;
  /**
   * Ordre d'affichage de la variante dans son groupe (croissant). La plus
   * petite valeur = meilleure variante = sélection par défaut. Absent = après
   * les variantes ordonnées (ordre du catalogue). Recopié dans l'`OSDefinition`
   * par `systems.ts`.
   */
  readonly variantOrder?: number;
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
 * Preuve de démarrage d'un système à disque démarré par BIOS (ex. Windows 7
 * à partir d'un disque RAW local ou d'un média importé).
 *
 * Ce système n'émet AUCUN marqueur LumiBoot. La preuve est une **lecture réelle
 * du disque dur** après le démarrage de l'émulateur (le BIOS/l'amorce exécute
 * l'image disque). `marker` sert d'identifiant documentaire et n'est jamais
 * scanné. Le délai est large : le POST, l'amorce et le chargement NT prennent
 * plusieurs minutes sous émulation logicielle.
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
    // Système MÈRE du groupe de variantes Debian : il n'a pas de
    // `variantGroupId` (il porte le groupe) mais expose son libellé de variant.
    // CLI est la variante la MOINS mise en avant : `variantOrder` le plus grand.
    variantName: 'CLI',
    variantOrder: 3,
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
    // Variant enfant rattaché à la mère console `debian-12-i386`.
    variantGroupId: 'debian-12-i386',
    variantName: 'X11',
    variantOrder: 2,
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
    // Variant enfant rattaché à la mère console `debian-12-i386`.
    variantGroupId: 'debian-12-i386',
    variantName: 'XFCE',
    // XFCE est la MEILLEURE variante Debian : `variantOrder` le plus petit, donc
    // première du groupe et sélectionnée par défaut.
    variantOrder: 1,
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
    // v86 est le seul moteur navigateur x86 32 bits intégré : la variante Lite
    // démarre directement le disque RAW local de l'opérateur par BIOS, sans
    // média à importer ni noyau Linux.
    engineId: 'v86',
    executionMode: 'browser',
    minMemoryMiB: 1024,
    configuration: {
      memoryMiB: 1024,
      vgaMemoryMiB: 16,
      bootDevice: 'disk',
    },
    // Invité NT : pilotes virtio absents, `ne2k` est le support commun émulé
    // par v86 (seuls `ne2k` et `virtio` existent). ACPI est requise par la
    // famille Vista+ (voir docs/windows-nt.md de v86).
    hardwareProfile: { ...pcHardware('ne2k'), acpi: true },
    // Disque local : le démarrage est prouvé par une lecture disque réelle.
    readiness: diskBootReadiness('windows-7-x86'),
    slug: 'windows-7-x86',
    // Système MÈRE du groupe de variantes Windows 7 : pas de `variantGroupId`.
    // Nom de base (le dropdown ajoute le `variantName`). Lite est la variante la
    // MOINS mise en avant : `variantOrder` le plus grand.
    displayName: 'Windows 7',
    versionLabel: 'x86',
    variantName: 'Lite',
    variantOrder: 2,
    // Boot bureau réel prouvé (canvas VGA 2D sous v86, E2E
    // tests/e2e/windows7-desktop.spec.ts, `VM_E2E_ASSETS=1`) : le profil est
    // validé, la disponibilité dérivée passe donc à `ready`.
    validated: true,
    description:
      'La variante « Lite » : Windows 7 x86 allégé, démarré par BIOS depuis ' +
      'son disque RAW 16 Gio local, sans installation.',
  },
  {
    id: 'windows-7-pro-sp1-x86',
    imageId: 'windows-7-pro-sp1-x86-image',
    // v86 est le seul moteur navigateur x86 32 bits intégré : Windows 7
    // Professionnel SP1 x86 démarre directement le disque RAW local de
    // l'opérateur par BIOS, sans média à importer ni noyau Linux.
    engineId: 'v86',
    executionMode: 'browser',
    // v86 arrondit `memory_size` à un multiple de 128 Kio et accepte les
    // valeurs non-puissances-de-deux : 1536 Mio (installé sous QEMU) est
    // accepté et requis par l'invité.
    minMemoryMiB: 1536,
    configuration: {
      memoryMiB: 1536,
      vgaMemoryMiB: 16,
      bootDevice: 'disk',
    },
    // Invité NT : pilotes virtio absents, `ne2k` est le support commun émulé
    // par v86 (seuls `ne2k` et `virtio` existent). ACPI est requise par la
    // famille Vista+ (voir docs/windows-nt.md de v86).
    hardwareProfile: { ...pcHardware('ne2k'), acpi: true },
    // Disque local : le démarrage est prouvé par une lecture disque réelle.
    readiness: diskBootReadiness('windows-7-pro-sp1-x86'),
    slug: 'windows-7-pro-sp1-x86',
    displayName: 'Windows 7 (Professionnel)',
    versionLabel: 'SP1 · x86',
    // Variant enfant rattaché à la mère Lite `windows-7-x86`. Professionnel est
    // la MEILLEURE variante Windows 7 : `variantOrder` le plus petit, donc
    // première du groupe et sélectionnée par défaut.
    variantGroupId: 'windows-7-x86',
    variantName: 'Professionnel',
    variantOrder: 1,
    // Boot prouvé par une lecture disque réelle (mode `disk-boot`, voir
    // docs/windows-7.md) : le profil est désormais validé.
    validated: true,
    description:
      'Une session Windows 7 Professionnel SP1 x86 dans le navigateur via v86, ' +
      'démarrée directement par BIOS depuis le disque RAW 32 Gio local, sans ' +
      'installation ni média à importer.',
  },
  {
    id: 'windows-10-x86',
    imageId: 'windows-10-x86-image',
    // v86 est le seul moteur navigateur x86 32 bits intégré : la variante x86
    // démarre directement le disque RAW local par BIOS, sans média à importer
    // ni noyau Linux — même pipeline que Windows 7.
    engineId: 'v86',
    executionMode: 'browser',
    // Plancher 2 Gio (aligné sur le lot matériel) : Windows 10 exige plus de
    // mémoire que Windows 7. v86 arrondit `memory_size` à un multiple de 128 Kio.
    minMemoryMiB: 2048,
    configuration: {
      memoryMiB: 2048,
      vgaMemoryMiB: 16,
      bootDevice: 'disk',
    },
    // L'image Windows 10 fournie embarque le pilote VirtIO NetKVM x86 : on
    // expose donc `virtio-net`, que v86 émulé supporte (device 0x1AF4:0x1041).
    // ACPI est requise par la famille Vista+ (voir docs/windows-nt.md de v86).
    hardwareProfile: { ...pcHardware('virtio'), acpi: true },
    // Disque local : le démarrage est prouvé par une lecture disque réelle (le
    // BIOS/l'amorce exécute l'image), jamais par un marqueur LumiBoot simulé.
    readiness: diskBootReadiness('windows-10-x86'),
    slug: 'windows-10-x86',
    // Système MÈRE du groupe de variantes Windows 10 : pas de `variantGroupId`.
    // Le nom de base est complété par le `variantName` dans le sélecteur.
    // x86 est la variante mise en avant : `variantOrder` le plus petit, donc
    // sélectionnée par défaut.
    displayName: 'Windows 10',
    versionLabel: 'x86 (32 bits)',
    variantName: '32 bits',
    variantOrder: 1,
    // Même pipeline disque local validé que Windows 7 : le profil est validé,
    // la disponibilité dérivée passe donc à `ready`.
    validated: true,
    description:
      'Une session Windows 10 x86 (32 bits) dans le navigateur via v86, démarrée ' +
      'directement par BIOS depuis le disque RAW local, sans installation ni média ' +
      'à importer.',
  },
  {
    id: 'windows-10-x64',
    imageId: 'windows-10-x64-image',
    // Moteur x86-64 NON intégré : le stub est conservé tel quel (même id, même
    // moteur, même média user-import) et rattaché comme variante FUTURE du
    // groupe Windows 10 x86. Aucun lancement n'est possible tant que le moteur
    // n'est pas branché.
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
    // Variant enfant rattaché à la mère x86 `windows-10-x86` : variante future
    // NON intégrée (v86 ne supporte pas le 64 bits), affichée après la mère.
    variantGroupId: 'windows-10-x86',
    variantName: '64 bits (non intégré)',
    variantOrder: 2,
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
