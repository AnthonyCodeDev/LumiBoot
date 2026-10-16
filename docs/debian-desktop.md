# Debian 12 i386 — flavors `minimal` et `desktop`

Ce document décrit la **deuxième image Debian** du catalogue, `debian-12-i386-desktop`, sans modifier
le comportement de l'image console existante (`debian-12-i386`, baseline E2E). Il précise l'état réel
du travail : **NON CONSTRUIT / NON TESTÉ**.

## 1. Objectifs

- Ajouter un **bureau graphique minimal** démarrable dans le navigateur via v86, sur la base
  Debian 12 Bookworm i386 déjà utilisée par la console.
- **Ne pas** dupliquer le script de construction : un **socle commun** est partagé, paramétré par un
  **flavor**.
- Ne **jamais** simuler une GUI côté React : la session graphique et sa preuve de démarrage
  proviennent exclusivement du système invité.
- **Ne jamais** marquer l'image desktop `ready` tant qu'aucune image réelle n'est construite,
  publiée et validée par un boot réel. La disponibilité du catalogue est **dérivée** (règle unique
  dans `packages/catalog/src/availability.ts`) et reste non-`ready`.

## 2. Flavors

| Flavor | Réf. | Base | Ajout | Sortie de build |
|---|---|---|---|---|
| `minimal` (défaut) | `debian-12-i386` | debootstrap `bookworm` minbase | console VGA + série | `images/debian-12-i386/build/` |
| `desktop` | `debian-12-i386-desktop` | socle **identique** | Xorg + Openbox + xterm | `images/debian-12-i386/build-desktop/` |

Le flavor est choisi par **argument** ou **variable** :

```bash
sudo ./images/debian-12-i386/build.sh              # minimal (comportement inchangé)
sudo ./images/debian-12-i386/build.sh desktop      # desktop
sudo FLAVOR=desktop ./images/debian-12-i386/build.sh
```

Le socle (debootstrap, clavier fr, locales, réseau DHCP/DNS, autologin non privilégié `lumiboot`,
extraction noyau/initrd, image ext4, manifeste) est **partagé**. Seule l'étape d'installation des
paquets et quelques overlays invités diffèrent.

## 3. Paquets ciblés (flavor `desktop`)

Ajoutés au socle commun (jamais de GNOME/KDE, jamais Wayland) :

| Paquet | Rôle |
|---|---|
| `xserver-xorg-core` | serveur X (Xorg) + pilote `modesetting` (KMS) |
| `xserver-xorg-video-fbdev` | pilote `fbdev` (framebuffer noyau `/dev/fb0`) — primaire sous v86 |
| `xserver-xorg-video-vesa` | pilote VBE — installé mais **non sélectionné** (incompatible KMS) |
| `xserver-xorg-input-libinput` | entrée clavier/souris (PS/2) |
| `xinit` | `startx` / `xinit` |
| `x11-xserver-utils` (`xset`, `xsetroot`, `xrdb`) | utilitaires de session |
| `x11-utils` (`xdpyinfo`) | **sonde** de vitalité du serveur X |
| `x11-xkb-utils` (`setxkbmap`) | clavier fr dans X |
| `xauth` | autorisation X locale |
| `xterm` | terminal de la session |
| `openbox` | gestionnaire de fenêtres |
| `fonts-dejavu-core` | polices (`DejaVu Sans Mono` pour xterm) |
| `dbus-x11` | bus D-Bus de session |

Configuration Xorg : `guest/desktop/xorg.conf.d/20-lumiboot-fbdev.conf` sélectionne le pilote
`fbdev` (framebuffer noyau `/dev/fb0`, fourni par le KMS `bochs-drm`) avec repli `modesetting`.
Un pilote VBE (`vesa`) échoue sous v86 : il refuse de s'attacher quand un pilote KMS est lié
(« no screens found »). Le module `bochs` n'est **pas** blacklisté en flavor desktop.

## 4. Interaction (flavor `desktop`)

- Autologin du compte **non privilégié** `lumiboot` sur `tty1` (jamais root).
- `~/.bash_profile` lance `startx` sur `tty1` (canvas VGA) si aucun `DISPLAY` n'existe.
- `~/.xinitrc` démarre le bus de session, règle le clavier fr, pose un fond uni, ouvre un `xterm`
  puis `exec openbox`.
- La console **série** (`ttyS0`) garde un shell normal, hors graphique.

## 5. Marqueurs : `GUEST_READY` **vs** `DESKTOP_READY`

Deux marqueurs **distincts**, tous deux écrits par l'invité sur la console série (`ttyS0`) :

| Marqueur | Émis quand | Signification |
|---|---|---|
| `LUMIBOOT_GUEST_READY:debian-12-i386-desktop` | `multi-user.target` atteint | l'**OS est opérationnel** |
| `LUMIBOOT_DESKTOP_READY:debian-12-i386-desktop` | socket X `:0` **+** `xdpyinfo` répond **+** Openbox tourne | la **session graphique** est réelle |

Le profil de lancement `debian-12-i386-desktop` attend `LUMIBOOT_DESKTOP_READY` : la session ne passe
`running` que si la GUI a **effectivement** démarré. En cas d'échec, un marqueur distinct
`LUMIBOOT_DESKTOP_START_FAILED:debian-12-i386-desktop` est émis et l'unité échoue — **aucun** faux
positif.

Ces marqueurs proviennent du système invité (unités systemd), **jamais** de JavaScript/React. Le
détecteur côté navigateur (`packages/provider-v86/src/guest-ready-detector.ts`) est agnostique au
contenu du marqueur : il lit simplement celui déclaré par le profil.

## 6. État réel — **NON CONSTRUIT / NON TESTÉ**

> **Aucune image desktop n'existe.** Ce dépôt ne peut pas exécuter `debootstrap` (pas de WSL/Docker,
> pas d'environnement Linux). Le script `build.sh` **n'a pas été exécuté**. Aucun boot graphique réel
> n'a été prouvé.

Au niveau du catalogue :

- `packages/catalog/src/images.ts` : `debian-12-i386-desktop-image` est déclarée **sans `imageRef`** —
  c'est la seule preuve qu'une image est présente, et elle est absente.
- `packages/catalog/src/profiles.ts` : `debian-12-i386-desktop` a `validated: false`.
- Conséquence : `getAggregatedAvailability` renvoie **`planned`** (jamais `ready`). Le manifeste
  `apps/web/public/images/debian-12-i386-desktop/manifest.json` est un **placeholder volontairement
  invalide** (rejeté par `ensureImageManifest`) : il ne peut pas simuler une image présente.

## 7. Procédure de construction (hors dépôt)

### Option A — machine Linux native ou WSL2 (recommandé)

```bash
# Dépendances (Debian/Ubuntu)
sudo apt-get install -y debootstrap e2fsprogs util-linux nodejs

# Construction du flavor desktop
sudo FLAVOR=desktop ./images/debian-12-i386/build.sh

# Publication (le dossier public est ignoré par Git : jamais de binaire en dépôt)
cp images/debian-12-i386/build-desktop/{rootfs.img,vmlinuz-686,initrd.img,manifest.json} \
   apps/web/public/images/debian-12-i386-desktop/
```

### Option B — conteneur Docker privilégié

```bash
docker run --rm -it --privileged -v "$PWD:/work" -w /work debian:bookworm bash -c '
  apt-get update && apt-get install -y debootstrap e2fsprogs util-linux nodejs
  FLAVOR=desktop ./images/debian-12-i386/build.sh'
```

### Option C — WSL2 (Windows)

```powershell
wsl --install -d Debian
wsl -e bash -lc "sudo apt-get update && sudo apt-get install -y debootstrap e2fsprogs nodejs"
wsl -e bash -lc "cd /mnt/c/Users/<vous>/Desktop/LumiBoot && sudo FLAVOR=desktop ./images/debian-12-i386/build.sh"
```

Ne jamais exécuter sous Windows natif : `debootstrap` et `chroot` exigent Linux.

## 8. Critères de passage en `ready`

Le flavor desktop ne peut devenir `ready` que si **toutes** ces conditions sont réunies :

1. Image réellement **construite** puis publiée dans `apps/web/public/images/debian-12-i386-desktop/`
   (avec `manifest.json` réel : SHA-256 calculés).
2. `images/debian-12-i386/tests/desktop-smoke-test.md` **entièrement vert** sur au moins un
   navigateur supporté par la version de v86 intégrée.
3. Le smoke test console (`boot-smoke-test.md`) reste vert (dépendance directe).
4. Le marqueur `LUMIBOOT_DESKTOP_READY` n'est observé **qu'après** une session graphique réelle
   (Openbox + xterm visibles, `xdpyinfo` répondant).
5. Alors seulement : renseigner `imageRef: 'debian-12-i386-desktop'` dans `images.ts` et
   `validated: true` dans `profiles.ts`.

Tant que ces conditions ne sont pas réunies, `debian-12-i386-desktop` **reste non-ready**.

> **Troisième flavor Debian :** l'image `debian-12-i386-xfce` (bureau **XFCE**) est décrite
> séparément dans [`docs/debian-xfce.md`](./debian-xfce.md). Elle partage le socle de construction et
> la configuration X (`fbdev`/`modesetting`) de ce flavor, mais reste **NON CONSTRUITE / NON
> TESTÉE** et donc `planned` dans le catalogue.
