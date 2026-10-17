# Licences et médias système

## Règles

- Aucun disque ou ISO propriétaire ne doit être committé ou distribué.
- Les fichiers `.img`, `.iso`, `.qcow2`, `.ext2` et `.bin` volumineux restent hors Git.
- Chaque manifeste doit indiquer provenance, taille et SHA-256 lorsque le média est publié.

## Composants

| Composant | Licence |
|---|---|
| Code LumiBoot | à définir par le mainteneur |
| v86 | BSD-2-Clause |
| React, Vite, Zod, Zustand | MIT |
| gorilla/websocket | BSD-2-Clause |
| wisp-python (`infra/wisp`) | AGPL-3.0 |

## Systèmes

- Debian : images construites depuis Bookworm avec provenance et paquets consignés.
- Windows 7 : disques RAW locaux de l'opérateur, ignorés par Git et servis en développement par HTTP Range. Aucune image ni clé n'est distribuée.
- Windows 10 (32 bits) : disque RAW **de l'opérateur**, converti depuis SA propre installation QEMU/VirtualBox, ignoré par Git et servi en développement par HTTP Range. Licence Windows de l'utilisateur requise ; aucune ISO, clé ou lien tiers n'est fourni, téléchargé ou redistribué. Même pipeline validé que Windows 7 (voir [`windows-10.md`](windows-10.md)).
- Windows 11 (64 bits) : médias utilisateur requis ; aucun moteur x86-64 n'est intégré.
- macOS : usage soumis à la licence Apple et au matériel autorisé.

Les icônes de systèmes sont des SVG locaux dans `apps/web/public/icons/os/`.
