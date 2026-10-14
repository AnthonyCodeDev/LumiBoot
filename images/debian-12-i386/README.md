# Image Debian 12 Bookworm i386 (v86)

> **Statut : script de construction réel, image non encore publiée.** Aucun binaire n'est versionné.
> Ne pas marquer Debian « Disponible » avant que les tests de `tests/boot-smoke-test.md` passent en
> navigateur.

## Objectif

Fournir une image Debian 12 i386 **légale, reproductible et documentée**, démarrable dans le
navigateur via v86, avec une console série interactive.

## Contenu

| Fichier | Rôle |
|---|---|
| `build.sh` | Construction reproductible (Linux/WSL2, debootstrap + image ext4 brute) |
| `write-manifest.mjs` | Génère `manifest.json` avec tailles et SHA-256 **réels** |
| `guest/lumiboot-ready.service` | Unité systemd qui émet le marqueur de disponibilité sur `ttyS0` |
| `guest/serial-getty-autologin.conf` | Autologin `lumiboot` sur la console série |
| `tests/boot-smoke-test.md` | Tests de démarrage réels et critères d'acceptation |
| `manifest.json` | Manifeste **placeholder** (jamais servi) : la vraie validation le rejetterait |

## Construire

Sur une machine Linux ou WSL2 disposant de `debootstrap`, `e2fsprogs`, `node` :

```bash
sudo ./images/debian-12-i386/build.sh
```

Produit dans `build/` : `rootfs.img` (ext4 brut), `vmlinuz-686`, `initrd.img`, `manifest.json`,
`packages.tsv` (versions réellement installées).

## Publier

```bash
cp images/debian-12-i386/build/{rootfs.img,vmlinuz-686,initrd.img,manifest.json} \
   apps/web/public/images/debian-12-i386/
```

Les gros fichiers ne sont pas versionnés (`.gitignore`) ; en CI/CD, les obtenir depuis un stockage
approuvé et vérifier les SHA du manifeste.

## Démarrage : trois artefacts

v86 est lancé en **boot direct du noyau** (`bzimage` + `initrd` + `hda`), pas via un installateur :

```text
apps/web/public/images/debian-12-i386/
├── manifest.json
├── vmlinuz-686
├── initrd.img
└── rootfs.img      # ext4 brut, pas un tar renommé
```

La ligne de commande par défaut du provider est
`console=tty0 console=ttyS0,115200 root=/dev/sda rw`. Le périphérique racine réellement vu par le
noyau doit être confirmé sur les logs de démarrage ; ajuster `boot.cmdline` dans le manifeste si
nécessaire.

## Preuve de démarrage

`booting → running` n'est déclenché **que** par le marqueur
`LUMIBOOT_GUEST_READY:debian-12-i386` émis par le système invité sur `ttyS0`. Le test E2E vérifie
ensuite des commandes invitées réelles (`uname -a`, `cat /etc/os-release`).

## Contraintes

- Debian 13 (Trixie) n'est **pas** une base valide : le noyau et l'installateur i386 natifs y ont
  été supprimés.
- Les gros fichiers restent hors Git.
