# Debian 12 i386 — flavor `xfce`

Ce document décrit la **troisième image Debian** du catalogue, `debian-12-i386-xfce`, sans modifier
le comportement des images existantes (`debian-12-i386` console et `debian-12-i386-desktop`
Xorg/Openbox). Il précise l'état réel du travail : **CONSTRUITE ET VALIDÉE PAR UN BOOT RÉEL**
(Xorg + session XFCE).

> **État : CONSTRUITE ET VALIDÉE.** Les binaires ne sont pas versionnés (dossier `public` ignoré par
> Git), mais l'image a été construite hors dépôt puis publiée, et **un boot XFCE réel a été prouvé**
> (voir § 7). Le catalogue présente donc `debian-12-i386-xfce` comme **`ready`**.

## 1. Objectifs

- Ajouter un **environnement de bureau complet XFCE** démarrable dans le navigateur via v86, sur la
  base Debian 12 Bookworm i386 déjà utilisée par la console et le flavor desktop.
- **Ne pas dupliquer** le script de construction : le **socle commun** et la **configuration X**
  (`fbdev`/`modesetting`) sont **partagés** par `desktop` et `xfce`. Seuls les paquets de bureau et
  les overlays invités propres à XFCE diffèrent.
- Ne **jamais** simuler une GUI côté React : la session XFCE et sa preuve de démarrage proviennent
  exclusivement du système invité.
- **Ne jamais** marquer l'image XFCE `ready` tant qu'aucune image réelle n'est construite, publiée et
  validée par un boot réel.

## 2. Flavor

| Flavor | Réf. | Base | Ajout | Disque | Sortie de build |
|---|---|---|---|---|---|
| `xfce` | `debian-12-i386-xfce` | socle **identique** au flavor `desktop` | **Xorg + XFCE** | **4 Gio** | `images/debian-12-i386/build-xfce/` |

Le flavor est choisi par **argument** ou **variable** :

```bash
sudo FLAVOR=xfce ./images/debian-12-i386/build.sh
# ou : sudo ./images/debian-12-i386/build.sh xfce
```

Différences de paramétrage du flavor `xfce` dans `build.sh` :

- `REF="debian-12-i386-xfce"`, `MEMORY_MIB="1024"`, `VGA_MIB="16"`.
- `BUILD_SUFFIX="-xfce"` → sortie dans `build-xfce/`.
- `DISK_SIZE_DEFAULT="4G"` (XFCE est volumineux) — surchargeable par `DISK_SIZE=…` comme avant.
- `READY_SERVICE_SRC="xfce/lumiboot-ready.service"`.
- Cmdline noyau des flavors graphiques : `… vga=0x318`, identique à `desktop`.

## 3. Paquets (flavor `xfce`)

Socle commun **inchangé**, plus :

| Paquet | Rôle |
|---|---|
| `xserver-xorg-core` | serveur X (Xorg) + pilote `modesetting` (KMS) |
| `xserver-xorg-video-fbdev` | pilote `fbdev` (framebuffer noyau `/dev/fb0`) — primaire sous v86 |
| `xserver-xorg-video-vesa` | pilote VBE — installé mais **non sélectionné** (incompatible KMS) |
| `xserver-xorg-input-libinput` | entrée clavier/souris (PS/2) |
| `xinit` | `startx` / `xinit` |
| `x11-xserver-utils`, `x11-utils`, `x11-xkb-utils`, `xauth` | utilitaires de session, sonde X, clavier fr |
| `fonts-dejavu-core` | polices |
| `dbus-x11` | bus D-Bus de session (requis par XFCE) |
| `xfce4`, `xfce4-session` | méta-paquet + gestionnaire de session XFCE |
| `xfwm4` | gestionnaire de fenêtres XFCE |
| `xfconf` | registre de configuration XFCE |
| `xfce4-panel` | panneau XFCE |
| `xfce4-terminal` | terminal XFCE |
| `thunar` | gestionnaire de fichiers XFCE |

**Pas de gestionnaire de connexion** (ni LightDM ni GDM) : démarrage direct de la session via
`startx` + `~/.xinitrc` après l'autologin du compte non privilégié `lumiboot`.

## 4. Configuration X (partagée avec `desktop`)

La configuration Xorg `fbdev` (repli `modesetting`) est **factorisée** dans un fichier unique
`images/debian-12-i386/guest/xorg.conf.d/20-lumiboot-fbdev.conf`, installé à l'identique pour les
flavors `desktop` **et** `xfce` dans `/etc/X11/xorg.conf.d/`. De même, le lanceur
`images/debian-12-i386/guest/lumiboot-startx` (essaie le ServerLayout `LumiBootFBDev`, puis
`LumiBootModesetting`) est **partagé**.

Sous v86 le noyau attache un pilote KMS `bochs-drm` (framebuffer `/dev/fb0`). Un pilote VBE (`vesa`)
refuse alors de s'attacher (« no screens found ») : on utilise `fbdev` en primaire et `modesetting`
en repli. Le module `bochs` n'est **pas** blacklisté.

`Xwrapper.config` (`allowed_users=anybody`, `needs_root_rights=yes`), le bit setuid de
`Xorg.wrap` et l'ajout de `lumiboot` au groupe `video` sont **identiques** au flavor desktop.

## 5. Interaction (flavor `xfce`)

- Autologin du compte **non privilégié** `lumiboot` sur `tty1` (jamais root).
- `~/.bash_profile` lance `startx` sur `tty1` (canvas VGA) si aucun `DISPLAY` n'existe.
- `~/.xinitrc` démarre le bus de session (`dbus-launch`), règle le clavier fr (`setxkbmap fr`) puis
  `exec startxfce4`.
- La console **série** (`ttyS0`) garde un shell normal, hors graphique.

## 6. Marqueurs : `GUEST_READY` **vs** `DESKTOP_READY`

Deux marqueurs **distincts**, tous deux écrits par l'invité sur la console série (`ttyS0`) :

| Marqueur | Émis quand | Signification |
|---|---|---|
| `LUMIBOOT_GUEST_READY:debian-12-i386-xfce` | `multi-user.target` atteint | l'**OS est opérationnel** |
| `LUMIBOOT_DESKTOP_READY:debian-12-i386-xfce` | socket X `:0` **+** `xdpyinfo` répond **+** `xfce4-session` **ou** `xfwm4` tourne | la **session XFCE** est réelle |

Le profil de lancement `debian-12-i386-xfce` attend `LUMIBOOT_DESKTOP_READY` : la session ne passe
`running` que si la GUI XFCE a **effectivement** démarré. En cas d'échec, un marqueur distinct
`LUMIBOOT_DESKTOP_START_FAILED:debian-12-i386-xfce` est émis et l'unité échoue — **aucun** faux
positif.

Ces marqueurs proviennent du système invité (unités systemd), **jamais** de JavaScript/React.

## 7. Validation réelle

La variante `debian-12-i386-xfce` a été **construite puis prouvée par un boot réel** le
**2026-10-15 / 2026-10-16** :

- **Environnement de build** : WSL2 (Debian `bookworm`), `debootstrap` + `chroot`, exécution de
  `sudo FLAVOR=xfce ./images/debian-12-i386/build.sh`.
- **Boot réel** : image publiée dans `apps/web/public/images/debian-12-i386-xfce/` puis lancée dans
  **v86** au sein du navigateur (non simulée côté JS/React).
- **Marqueurs observés** (sortie série `ttyS0`) :
  1. `LUMIBOOT_GUEST_READY:debian-12-i386-xfce` — OS opérationnel (`multi-user.target`).
  2. `LUMIBOOT_DESKTOP_READY:debian-12-i386-xfce` — Xorg + session XFCE (`xfce4-session`/`xfwm4`)
     réellement démarrés (`xdpyinfo` répond).
- **Bureau** : la session XFCE s'affiche dans le navigateur (canvas VGA en mode graphique).

**Performance** : XFCE est sensiblement plus lourd qu'Openbox sous v86 (émulation logicielle,
sans accélération). Le délai jusqu'au marqueur `LUMIBOOT_DESKTOP_READY` est donc plus élevé que
pour `debian-12-i386-desktop` ; le budget de démarrage du profil (`240 s`) reste suffisant.

Messages bénins observés sur la console série, sans incidence sur la disponibilité :

- `romain.perier@gmail.com` : certificat de signature de la base **cfg80211** (`regulatory.db`),
  pas une erreur de l'image.
- `regulatory.db` : firmware de régulation WiFi absent — **normal**, l'invité n'embarque pas de
  firmware WiFi (réseau émulé `virtio-net`).

## 8. État réel — **construite et validée**

Au niveau du catalogue :

- `packages/catalog/src/images.ts` : `debian-12-i386-xfce-image` déclare
  `imageRef: 'debian-12-i386-xfce'` — l'image est présente.
- `packages/catalog/src/profiles.ts` : `debian-12-i386-xfce` a `validated: true`.
- Conséquence : `getAggregatedAvailability` renvoie **`ready`**.

## 9. Procédure de construction (hors dépôt)

### Option A — machine Linux native ou WSL2 (recommandé)

```bash
# Dépendances (Debian/Ubuntu)
sudo apt-get install -y debootstrap e2fsprogs util-linux nodejs

# Construction du flavor xfce
sudo FLAVOR=xfce ./images/debian-12-i386/build.sh

# Publication (le dossier public est ignoré par Git : jamais de binaire en dépôt)
cp images/debian-12-i386/build-xfce/{rootfs.img,vmlinuz-686,initrd.img,manifest.json} \
   apps/web/public/images/debian-12-i386-xfce/
```

### Option B — conteneur Docker privilégié

```bash
docker run --rm -it --privileged -v "$PWD:/work" -w /work debian:bookworm bash -c '
  apt-get update && apt-get install -y debootstrap e2fsprogs util-linux nodejs
  FLAVOR=xfce ./images/debian-12-i386/build.sh'
```

### Option C — WSL2 (Windows)

```powershell
wsl --install -d Debian
wsl -e bash -lc "sudo apt-get update && sudo apt-get install -y debootstrap e2fsprogs nodejs"
wsl -e bash -lc "cd /mnt/c/Users/<vous>/Desktop/LumiBoot && sudo FLAVOR=xfce ./images/debian-12-i386/build.sh"
```

Ne jamais exécuter sous Windows natif : `debootstrap` et `chroot` exigent Linux.

## 10. Critères de passage en `ready` — **réunis**

Le flavor XFCE n'est passé `ready` qu'après que **toutes** ces conditions ont été réunies :

1. Image réellement **construite** puis publiée dans `apps/web/public/images/debian-12-i386-xfce/`
   (avec `manifest.json` réel : SHA-256 calculés).
2. `images/debian-12-i386/tests/xfce-smoke-test.md` **entièrement vert** sur au moins un navigateur.
3. Le smoke test console (`boot-smoke-test.md`) reste vert (dépendance directe).
4. Le marqueur `LUMIBOOT_DESKTOP_READY` n'a été observé **qu'après** une session XFCE réelle
   (panneau XFCE + `xfwm4` visibles, `xdpyinfo` répondant).
5. `imageRef: 'debian-12-i386-xfce'` dans `images.ts` et `validated: true` dans `profiles.ts`.

> Voir aussi le flavor Openbox : [`docs/debian-desktop.md`](./debian-desktop.md).
