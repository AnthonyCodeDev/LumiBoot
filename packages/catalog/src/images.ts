import type { Architecture } from '@lumiboot/contracts';

/**
 * Description factuelle d'une image système.
 *
 * Ce fichier ne déclare AUCUN statut de disponibilité : la disponibilité est
 * calculée une seule fois, dans `systems.ts`, via `getEffectiveAvailability`.
 * La présence effective d'une image se lit uniquement à travers `imageRef`.
 */
export interface SystemImageDefinition {
  readonly id: string;
  readonly familyId: string;
  readonly architecture: Architecture;
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
    // Référence du manifeste d'image (indépendante du moteur choisi par le profil).
    // C'est la seule preuve qu'une image est réellement construite/disponible.
    imageRef: 'debian-12-i386',
    requirements: ['Navigateur moderne', 'WebAssembly', 'Mémoire suffisante'],
    integrationNote: "Premier système du MVP. L'image Linux arrive en premier lot.",
  },
  {
    id: 'debian-12-i386-desktop-image',
    familyId: 'debian',
    architecture: 'i386',
    // Image desktop construite et publiée. La seule preuve de présence reste
    // `imageRef` ; la disponibilité demeure DÉRIVÉE et dépend aussi d'un boot
    // réel validé (`validated` du profil — voir docs/debian-desktop.md).
    imageRef: 'debian-12-i386-desktop',
    requirements: [
      'Navigateur moderne',
      'WebAssembly',
      'Mémoire suffisante (≥ 1 Gio)',
      'Image graphique (Xorg) publiée',
    ],
    integrationNote:
      'Variante graphique de Debian 12 (Xorg + Openbox sous v86) : boot réel ' +
      'validé (voir docs/debian-desktop.md).',
  },
  {
    id: 'debian-12-i386-xfce-image',
    familyId: 'debian',
    architecture: 'i386',
    // Image XFCE construite (flavor xfce) et publiée. La seule preuve de
    // présence reste `imageRef` ; la disponibilité demeure DÉRIVÉE et dépend
    // aussi d'un boot réel validé (`validated` du profil — voir docs/debian-xfce.md).
    imageRef: 'debian-12-i386-xfce',
    requirements: [
      'Navigateur moderne',
      'WebAssembly',
      'Mémoire suffisante (≥ 1 Gio)',
      'Disque XFCE (~4 Gio)',
    ],
    integrationNote:
      'Variante Debian 12 à environnement de bureau complet XFCE (Xorg + XFCE sous v86) : ' +
      'boot réel validé (voir docs/debian-xfce.md).',
  },
  {
    id: 'ubuntu-18-i386-image',
    familyId: 'ubuntu',
    architecture: 'i386',
    requirements: ['Image i386 compatible', 'Tests de démarrage'],
    integrationNote:
      'Version ancienne retenue pour une compatibilité navigateur plausible. Image à brancher au lot Debian.',
  },
  {
    id: 'fedora-workstation-image',
    familyId: 'fedora',
    architecture: 'x86_64',
    requirements: ['WebAssembly', 'Mémoire suffisante', 'Architecture x86-64'],
    integrationNote: 'Image de base à associer à un moteur navigateur x86-64.',
  },
  {
    id: 'mint-x64-image',
    familyId: 'mint',
    architecture: 'x86_64',
    requirements: ['WebAssembly', 'Mémoire suffisante', 'Architecture x86-64'],
    integrationNote: 'Image de base à associer à un moteur navigateur x86-64.',
  },
  {
    id: 'windows-7-x86-image',
    familyId: 'windows',
    architecture: 'i386',
    requirements: ['WebAssembly', 'Licence et média autorisés', 'Mémoire suffisante'],
    licenseNotes: 'Média et licence fournis par l’utilisateur. Aucune redistribution.',
    integrationNote: 'Image de base à associer à un moteur navigateur x86 32 bits.',
  },
  {
    id: 'windows-10-x64-image',
    familyId: 'windows',
    architecture: 'x86_64',
    requirements: ['WebAssembly', 'Licence Windows valide', 'Mémoire suffisante'],
    licenseNotes: 'Licence Windows requise. Aucune ISO propriétaire fournie.',
    integrationNote: 'Image de base à associer à un moteur navigateur x86-64.',
  },
  {
    id: 'windows-11-x64-image',
    familyId: 'windows',
    architecture: 'x86_64',
    requirements: ['WebAssembly', 'TPM virtuel selon configuration', 'Licence Windows'],
    licenseNotes: 'Licence Windows requise. Aucune ISO propriétaire fournie.',
    integrationNote: 'Image de base à associer à un moteur navigateur x86-64.',
  },
  {
    id: 'macos-sequoia-image',
    familyId: 'macos',
    architecture: 'arm64',
    requirements: ['WebAssembly', 'Mémoire suffisante', 'Conformité à la licence macOS'],
    licenseNotes: 'Virtualisation macOS soumise à la licence Apple et au matériel compatible.',
    integrationNote: 'Image de base à associer à un moteur navigateur ARM.',
  },
] as const satisfies readonly SystemImageDefinition[];
