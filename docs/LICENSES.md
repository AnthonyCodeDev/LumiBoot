# Licences et images système

## Règle d'or

**Aucun fichier d'image système (`.img`, `.iso`, `.qcow2`, `.ext2`, `.bin`) n'est committé dans ce
dépôt.** Seuls des **manifestes** (URL, taille, `sha256`, licence, provenance) sont versionnés.

## Logiciels du projet

| Composant | Licence |
|---|---|
| Code LumiBoot | à définir par le mainteneur |
| v86 | BSD-2-Clause |
| React, Vite, Fastify, Zod, Zustand | MIT |

## Images de systèmes

- **Debian** : images libres et redistribuables ; documenter la provenance et la licence dans
  `images/debian-12-i386/`.
- **Windows 7 / 10 / 11** : média et licence **fournis par l'utilisateur**. Aucune redistribution
  d'ISO propriétaire. Respecter les conditions Microsoft. Windows 7 x86 sous v86 est
  **sélectionnable mais jamais `ready`** : l'utilisateur importe localement un disque qu'il détient
  légalement (voir [`windows-7.md`](windows-7.md)). Aucune clé ni
  image n'est committée.
- **macOS** : virtualisation soumise à la licence Apple et au matériel Apple compatible. Ne pas
  promettre de compatibilité multi-version globale. Voir https://www.apple.com/legal/sla/.

## Provenance des visuels

Toutes les illustrations de cartes sont des SVG produits pour le projet, livrés localement dans
`apps/web/public/icons/os/`. Aucune dépendance à un CDN d'illustrations.
