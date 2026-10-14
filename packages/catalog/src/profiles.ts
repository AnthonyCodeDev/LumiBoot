import type { EngineId, ExecutionMode, VMConfiguration } from '@lumiboot/contracts';

/**
 * Description factuelle d'un profil de lancement (image + moteur + paramètres).
 *
 * Ce fichier ne déclare AUCUN statut de disponibilité : la disponibilité est
 * calculée une seule fois, dans `systems.ts`. `validated` atteste uniquement
 * qu'un boot réel a été prouvé pour ce couple image/moteur.
 */
export interface LaunchProfileDefinition {
  readonly id: string;
  readonly imageId: string;
  readonly engineId: EngineId;
  readonly executionMode: ExecutionMode;
  readonly minMemoryMiB: number;
  readonly configuration?: VMConfiguration;
  readonly slug: string;
  readonly displayName: string;
  readonly versionLabel: string;
  readonly description: string;
  /** Boot réel prouvé pour ce profil (tests E2E). */
  readonly validated: boolean;
  readonly featured?: boolean;
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
    slug: 'debian-12-i386',
    displayName: 'Debian',
    versionLabel: '12 Bookworm',
    validated: true,
    featured: true,
    description:
      "Une distribution Linux stable, flexible et idéale pour découvrir un véritable système d'exploitation en navigateur.",
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
    slug: 'mint-x64',
    displayName: 'Linux Mint',
    versionLabel: 'Cinnamon · x64',
    validated: false,
    description: 'Un bureau Linux classique et accessible, à lancer dans le navigateur.',
  },
  {
    id: 'windows-7-x86',
    imageId: 'windows-7-x86-image',
    engineId: 'wasm-x86',
    executionMode: 'browser',
    minMemoryMiB: 2048,
    configuration: {
      memoryMiB: 2048,
      bootDevice: 'disk',
    },
    slug: 'windows-7-x86',
    displayName: 'Windows 7',
    versionLabel: 'Édition x86',
    validated: false,
    description:
      'Une session Windows classique dans le navigateur, sous réserve d’une licence valide et d’un moteur compatible.',
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
    slug: 'macos-sequoia',
    displayName: 'macOS',
    versionLabel: 'Sequoia · Apple Silicon',
    validated: false,
    description: 'Une session macOS pensée pour un futur moteur navigateur compatible ARM.',
  },
] as const satisfies readonly LaunchProfileDefinition[];
