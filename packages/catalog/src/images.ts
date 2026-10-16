import type { Architecture, MediaStrategy } from '@lumiboot/contracts';

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
  /**
   * Origine du média : `bundled` (défaut, servi par LumiBoot) ou `user-import`
   * (média fourni par l'utilisateur, jamais distribué). Voir docs/windows-7.md.
   */
  readonly mediaStrategy?: MediaStrategy;
  /**
   * Vrai si ce système ne peut PAS démarrer sans média local importé par
   * l'utilisateur. Pilote l'état honnête `resource-required` tant que le média
   * n'est pas présent (aucun `imageRef` n'est alors déclaré).
   */
  readonly requiresUserMedia?: boolean;
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
    // Disque RAW 16 Gio de l'opérateur (images/windows-7-x86/disk.img, ignoré
    // par Git) servi localement en HTTP Range. Aucun import : il est démarré
    // directement par BIOS sous v86 (voir docs/windows-7.md). Variante « Lite »,
    // base (mère) du groupe de variantes Windows 7.
    imageRef: 'windows-7-x86',
    requirements: [
      'Navigateur moderne avec WebAssembly (v86)',
      'Disque RAW local servi en HTTP Range (images/windows-7-x86/disk.img)',
      'Mémoire invitée 1024 Mio',
      'Démarrage disque (MBR) ; pas de noyau Linux',
    ],
    integrationNote:
      'Démarrage BIOS direct du disque RAW local par hda IDE (jamais en cdrom), ' +
      'lu en HTTP Range via v86. Base immuable, écritures invitées en mémoire le ' +
      'temps de la session. Variante « Lite ».',
  },
  {
    id: 'windows-7-pro-sp1-x86-image',
    familyId: 'windows',
    architecture: 'i386',
    // Disque RAW 32 Gio de l'opérateur (images/windows-7-pro-sp1-x86/disk.img,
    // ignoré par Git) servi localement en HTTP Range. Aucun import : il est
    // démarré directement par BIOS sous v86 (voir docs/windows-7.md). Variante
    // « Professionnel » du groupe de variantes Windows 7.
    imageRef: 'windows-7-pro-sp1-x86',
    requirements: [
      'Navigateur moderne avec WebAssembly (v86)',
      'Disque RAW 32 Gio servi en HTTP Range (images/windows-7-pro-sp1-x86/disk.img)',
      'Mémoire invitée 1536 Mio (arrondie à 128 Kio près par v86)',
      'Démarrage disque (MBR) ; pas de noyau Linux',
    ],
    integrationNote:
      'Démarrage BIOS direct du disque RAW local par hda en IDE (jamais en cdrom), ' +
      'lu en HTTP Range via v86. La base disque n’est jamais modifiée : les écritures ' +
      'invitées restent en mémoire le temps de la session.',
  },
  {
    id: 'windows-10-x64-image',
    familyId: 'windows',
    architecture: 'x86_64',
    mediaStrategy: 'user-import',
    requirements: ['WebAssembly', 'Licence Windows valide', 'Mémoire suffisante'],
    licenseNotes: 'Licence Windows requise. Aucune ISO propriétaire fournie.',
    integrationNote: 'Image de base à associer à un moteur navigateur x86-64.',
  },
  {
    id: 'windows-11-x64-image',
    familyId: 'windows',
    architecture: 'x86_64',
    mediaStrategy: 'user-import',
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
