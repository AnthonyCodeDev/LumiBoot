import type { Architecture, Availability } from '@lumiboot/contracts';

export interface SystemImageDefinition {
  readonly id: string;
  readonly familyId: string;
  readonly architecture: Architecture;
  readonly availability: Availability;
  readonly imageRef?: string;
  readonly requirements: readonly string[];
  readonly licenseNotes?: string;
  readonly integrationNote: string;
}

export const images = [
  {
    id: 'debian-12-i386-image',
    familyId: 'debian',
    architecture: 'i386',
    // `ready` uniquement après un boot réel prouvé dans le navigateur (tests E2E).
    availability: 'ready',
    // Référence du manifeste d'image (indépendante du moteur choisi par le profil).
    imageRef: 'debian-12-i386',
    requirements: ['Navigateur moderne', 'WebAssembly', 'Mémoire suffisante'],
    integrationNote: "Premier système du MVP. L'image Linux arrive en premier lot.",
  },
  {
    id: 'ubuntu-18-i386-image',
    familyId: 'ubuntu',
    architecture: 'i386',
    availability: 'planned',
    requirements: ['Image i386 compatible', 'Tests de démarrage'],
    integrationNote:
      'Version ancienne retenue pour une compatibilité navigateur plausible. Image à brancher au lot Debian.',
  },
  {
    id: 'fedora-workstation-image',
    familyId: 'fedora',
    architecture: 'x86_64',
    availability: 'planned',
    requirements: ['WebAssembly', 'Mémoire suffisante', 'Architecture x86-64'],
    integrationNote: 'Image de base à associer à un moteur navigateur x86-64.',
  },
  {
    id: 'mint-x64-image',
    familyId: 'mint',
    architecture: 'x86_64',
    availability: 'planned',
    requirements: ['WebAssembly', 'Mémoire suffisante', 'Architecture x86-64'],
    integrationNote: 'Image de base à associer à un moteur navigateur x86-64.',
  },
  {
    id: 'windows-7-x86-image',
    familyId: 'windows',
    architecture: 'i386',
    availability: 'planned',
    requirements: ['WebAssembly', 'Licence et média autorisés', 'Mémoire suffisante'],
    licenseNotes: 'Média et licence fournis par l’utilisateur. Aucune redistribution.',
    integrationNote: 'Image de base à associer à un moteur navigateur x86 32 bits.',
  },
  {
    id: 'windows-10-x64-image',
    familyId: 'windows',
    architecture: 'x86_64',
    availability: 'planned',
    requirements: ['WebAssembly', 'Licence Windows valide', 'Mémoire suffisante'],
    licenseNotes: 'Licence Windows requise. Aucune ISO propriétaire fournie.',
    integrationNote: 'Image de base à associer à un moteur navigateur x86-64.',
  },
  {
    id: 'windows-11-x64-image',
    familyId: 'windows',
    architecture: 'x86_64',
    availability: 'planned',
    requirements: ['WebAssembly', 'TPM virtuel selon configuration', 'Licence Windows'],
    licenseNotes: 'Licence Windows requise. Aucune ISO propriétaire fournie.',
    integrationNote: 'Image de base à associer à un moteur navigateur x86-64.',
  },
  {
    id: 'macos-sequoia-image',
    familyId: 'macos',
    architecture: 'arm64',
    availability: 'planned',
    requirements: ['WebAssembly', 'Mémoire suffisante', 'Conformité à la licence macOS'],
    licenseNotes: 'Virtualisation macOS soumise à la licence Apple et au matériel compatible.',
    integrationNote: 'Image de base à associer à un moteur navigateur ARM.',
  },
] as const satisfies readonly SystemImageDefinition[];
