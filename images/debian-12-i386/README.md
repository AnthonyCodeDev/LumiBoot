# Image Debian 12 Bookworm i386 (v86)

> **Statut : scripts de construction réels, images NON encore publiées, AUCUN boot réel prouvé.**
> Aucun binaire n'est versionné. **Le flavor `desktop` n'a jamais été construit ni démarré.**
> Ne pas marquer Debian « Disponible » avant que les smoke tests passent en navigateur.

## Objectif

Fournir une image Debian 12 i386 **légale, reproductible et documentée**, démarrable dans le
navigateur via v86. Deux **flavors** partagent le même socle de construction (aucun copier-coller) :

| Flavor | Réf. d'image | Contenu | Marqueurs invités |
|---|---|---|---|
| `minimal` (défaut) | `debian-12-i386` | Console VGA + série (baseline E2E validée) | `LUMIBOOT_GUEST_READY:debian-12-i386` |
| `desktop` (nouveau) | `debian-12-i386-desktop` | Socle minimal + **Xorg + Openbox + xterm** | `LUMIBOOT_GUEST_READY:debian-12-i386-desktop` **puis** `LUMIBOOT_DESKTOP_READY:debian-12-i386-desktop` |

> **Vérité de l'état actuel :** aucune image réelle ne peut être construite ni bootée dans
> l'environnement de développement (pas de `debootstrap`, ni WSL, ni Docker). Le **flavor desktop
> est NON CONSTRUIT / NON TESTÉ** et n'est donc jamais annoncé comme disponible par le catalogue
> (voir `docs/debian-desktop.md`). La disponibilité est **dérivée** et reste non-`ready`.

## Contenu

| Fichier | Rôle |
|---|---|
| `build.sh` | Construction reproductible (Linux/WSL2, debootstrap + image ext4 brute), flavor via `FLAVOR`/argv |
| `write-manifest.mjs` | Génère `manifest.json` avec tailles et SHA-256 **réels** (paramétrable par flavor) |
| `guest/lumiboot-ready.service` | Unité systemd (flavor minimal) qui émet `LUMIBOOT_GUEST_READY` sur `ttyS0` |
| `guest/desktop/lumiboot-ready.service` | Idem pour le flavor desktop (réf. `…-desktop`) |
| `guest/desktop/lumiboot-desktop-ready.{service,sh}` | Émet `LUMIBOOT_DESKTOP_READY` **après** X + Openbox réels |
| `guest/desktop/bash_profile`, `guest/desktop/xinitrc` | Entrée graphique (autologin `lumiboot` → startx → Openbox + xterm) |
| `guest/desktop/xorg.conf.d/20-lumiboot-fbdev.conf` | Pilote X `fbdev` (framebuffer noyau `bochs-drm`) + repli `modesetting` |
| `guest/serial-getty-autologin.conf` | Autologin `lumiboot` sur la console série |
| `tests/boot-smoke-test.md` | Smoke test console (flavor minimal) |
| `tests/desktop-smoke-test.md` | Smoke test graphique (flavor desktop) |
| `manifest.json` | Manifeste **placeholder** (flavor minimal, jamais servi) : la vraie validation le rejetterait |
| `manifest-desktop.json` | Manifeste **placeholder** (flavor desktop, versionné) ; la copie publiée est `apps/web/public/images/debian-12-i386-desktop/manifest.json` |

## Construire

Sur une machine Linux ou WSL2 disposant de `debootstrap`, `e2fsprogs`, `node` :

```bash
# Flavor console (défaut) — baseline E2E validée, comportement inchangé.
sudo ./images/debian-12-i386/build.sh

# Flavor graphique (Xorg + Openbox) — à tester sur machine adaptée.
sudo FLAVOR=desktop ./images/debian-12-i386/build.sh
# ou : sudo ./images/debian-12-i386/build.sh desktop
```

Produit dans `build/` (minimal) ou `build-desktop/` (desktop) : `rootfs.img` (ext4 brut),
`vmlinuz-686`, `initrd.img`, `manifest.json`, `packages.tsv` (versions réellement installées) et
`provenance.txt` (miroir, release, snapshot éventuel, date).

### Reproductibilité / verrouillage

- Release Debian **figée** à `bookworm` (Debian 13 Trixie n'a plus d'installateur ni de noyau i386).
- Snapshot daté optionnel via `snapshot.debian.org` :
  `sudo SNAPSHOT=20240101T000000Z ./images/debian-12-i386/build.sh`.
- `packages.tsv` liste les versions **réellement installées** ; `manifest.json` contient les
  SHA-256 **réels** des artefacts (calculés, jamais inventés).

## Publier

```bash
# minimal
cp images/debian-12-i386/build/{rootfs.img,vmlinuz-686,initrd.img,manifest.json} \
   apps/web/public/images/debian-12-i386/
# desktop
cp images/debian-12-i386/build-desktop/{rootfs.img,vmlinuz-686,initrd.img,manifest.json} \
   apps/web/public/images/debian-12-i386-desktop/
```

Les gros fichiers ne sont pas versionnés (`.gitignore`) ; en CI/CD, les obtenir depuis un stockage
approuvé et vérifier les SHA du manifeste.

## Démarrage : trois artefacts

v86 est lancé en **boot direct du noyau** (`bzimage` + `initrd` + `hda`), pas via un installateur :

```text
apps/web/public/images/debian-12-i386{,-desktop}/
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

- `booting → running` n'est déclenché **que** par le marqueur émis par le système invité sur `ttyS0`.
- **Flavor minimal** : `LUMIBOOT_GUEST_READY:debian-12-i386`.
- **Flavor desktop** : le profil attend `LUMIBOOT_DESKTOP_READY:debian-12-i386-desktop`, émis **après**
  que le serveur X réponde (`xdpyinfo`) et qu'Openbox tourne. Le marqueur `LUMIBOOT_GUEST_READY`
  (OS opérationnel) est émis **avant**, séparément. Une GUI est donc **jamais** simulée côté Web.

## Contraintes

- Debian 13 (Trixie) n'est **pas** une base valide : le noyau et l'installateur i386 natifs y ont
  été supprimés.
- Le flavor desktop vise **X11 (Xorg + Openbox)** uniquement : pas de GNOME/KDE, pas de Wayland.
- Les gros fichiers restent hors Git.

Détails, état réel et critères de passage en `ready` : [`docs/debian-desktop.md`](../../docs/debian-desktop.md).
