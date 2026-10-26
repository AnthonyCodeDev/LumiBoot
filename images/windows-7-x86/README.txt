Windows 7 x86 — image disque NON fournie
========================================
Aucun disque n'est versionné dans ce dossier.

En local :
  1. placer votre propre disque RAW ici : disk.img
  2. régénérer le manifeste :
     pnpm assets:windows7:prepare -- --ref windows-7-x86 --out images/windows-7-x86

manifest.json décrit le disque (taille, démarrage BIOS, URL
/images/windows-7-x86/disk.img) ; il ne contient aucun chemin local.
