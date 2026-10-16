#!/usr/bin/env bash
#
# Construction reproductible d'une image Debian 12 Bookworm i386 pour v86.
#
#   sudo ./images/debian-12-i386/build.sh              # flavor « minimal » (console, défaut)
#   sudo FLAVOR=desktop ./images/debian-12-i386/build.sh   # flavor « desktop » (Xorg + Openbox)
#   sudo FLAVOR=xfce ./images/debian-12-i386/build.sh      # flavor « xfce » (Xorg + XFCE)
#   sudo ./images/debian-12-i386/build.sh desktop          # équivalent (flavor en 1er argument)
#
# À exécuter sous Linux ou WSL2, jamais sous Windows natif ni dans un pipeline
# qui n'a pas debootstrap. Ne committe jamais les binaires produits.
#
# ⚠️  CE SCRIPT N'A PAS ÉTÉ EXÉCUTÉ dans l'environnement de développement de ce
#     dépôt (pas de debootstrap, ni WSL, ni Docker, aucune image ne peut être
#     construite ni bootée ici). Il doit être testé sur une machine Linux/WSL2
#     adaptée AVANT toute publication. Aucun boot réel n'est prouvé à ce stade.
#
# Trois flavors partagent le MÊME socle ci-dessous (aucun copier-coller) :
#
#   * minimal  (défaut) — baseline E2E validée : console série + VGA, marqueur
#              LUMIBOOT_GUEST_READY:debian-12-i386. Comportement/compatibilité
#              INCHANGÉS par rapport à la version précédente du script.
#   * desktop  — socle minimal + pile graphique Xorg/Openbox (voir §4d), session
#              graphique sur le canvas VGA (autologin du compte non privilégié
#              « lumiboot », jamais root). Émet
#              LUMIBOOT_GUEST_READY:debian-12-i386-desktop (OS opérationnel)
#              PUIS, seulement après le démarrage effectif du serveur X et de la
#              session, LUMIBOOT_DESKTOP_READY:debian-12-i386-desktop.
#   * xfce     — socle minimal + pile graphique Xorg/XFCE (environnement de
#              bureau complet). Mêmes marqueurs, préfixés
#              LUMIBOOT_GUEST_READY:debian-12-i386-xfce puis
#              LUMIBOOT_DESKTOP_READY:debian-12-i386-xfce. Sa configuration X
#              (fbdev/modesetting) est PARTAGÉE avec le flavor desktop. ⚠️ XFCE
#              n'a PAS encore été construit ni testé : aucun boot réel prouvé.
#
#     Les marqueurs sont émis par le système INVITÉ via systemd (voir guest/),
#     jamais par JavaScript, et écrits sur la console série (ttyS0).
#
# Résultat dans images/debian-12-i386/build[-desktop|-xfce]/ :
#   rootfs.img      disque ext4 brut (racine Debian)
#   vmlinuz-686     noyau (bzimage) de la même version que l'initrd
#   initrd.img      initramfs correspondant
#   manifest.json   tailles + SHA-256 réels (schéma strict @lumiboot/vm-assets)
#   packages.tsv    versions réellement installées (traçabilité)
#   provenance.txt  miroir, release, snapshot éventuel, date, version debootstrap
#
# VERROUILLAGE : la release Debian est figée (bookworm). Pour un build
# strictement reproductible, pointer un snapshot daté :
#   sudo SNAPSHOT=20240101T000000Z ./images/debian-12-i386/build.sh
# (les paquets proviennent alors de snapshot.debian.org, cf. §2).
set -euo pipefail

# --- Paramétrage du flavor ---------------------------------------------------
FLAVOR="${1:-${FLAVOR:-minimal}}"
case "$FLAVOR" in
  minimal)
    REF="debian-12-i386"
    MEMORY_MIB="512"
    VGA_MIB="16"
    BUILD_SUFFIX=""
    READY_SERVICE_SRC=""
    GUEST_DIR=""
    DISK_SIZE_DEFAULT="3G"
    ;;
  desktop)
    REF="debian-12-i386-desktop"
    MEMORY_MIB="1024"
    VGA_MIB="16"
    BUILD_SUFFIX="-desktop"
    READY_SERVICE_SRC="desktop/lumiboot-ready.service"
    GUEST_DIR="desktop"
    DISK_SIZE_DEFAULT="3G"
    ;;
  xfce)
    REF="debian-12-i386-xfce"
    MEMORY_MIB="1024"
    VGA_MIB="16"
    BUILD_SUFFIX="-xfce"
    READY_SERVICE_SRC="xfce/lumiboot-ready.service"
    GUEST_DIR="xfce"
    # XFCE est nettement plus volumineux que le socle : disque élargi à 4 Gio
    # (surchargeable par DISK_SIZE=… comme avant).
    DISK_SIZE_DEFAULT="4G"
    ;;
  *)
    echo "Flavor inconnu : « $FLAVOR » (attendu : minimal | desktop | xfce)." >&2
    exit 1
    ;;
esac

# Flavor graphique (Xorg + gestionnaire de session) : desktop (Openbox) ou xfce.
# Pilote le partage de la plupart des étapes (pile graphique, session, marqueur).
GRAPHICAL=""
if [ "$FLAVOR" = "desktop" ] || [ "$FLAVOR" = "xfce" ]; then
  GRAPHICAL="true"
fi

RELEASE="bookworm"
ARCH="i386"
DEBIAN_MIRROR="${DEBIAN_MIRROR:-https://deb.debian.org/debian}"
SECURITY_MIRROR="${SECURITY_MIRROR:-http://security.debian.org/debian-security}"
# Snapshot daté optionnel (format snapshot.debian.org : 20240101T000000Z).
SNAPSHOT="${SNAPSHOT:-}"
DISK_SIZE="${DISK_SIZE:-$DISK_SIZE_DEFAULT}"

# Cmdline noyau des flavors graphiques (desktop et xfce). Identique au socle
# (V86Provider.DEFAULT_BOOT_CMDLINE) PLUS « vga=0x318 » (1024×768×24) : sous v86
# il n'y a pas de DRM, on force donc la console framebuffer VBE du noyau pour
# obtenir /dev/fb0, requis par le repli Xorg « fbdev ». Le flavor minimal
# n'émet PAS de boot.cmdline : il garde la console VGA texte et le
# DEFAULT_BOOT_CMDLINE du provider (comportement inchangé).
DESKTOP_CMDLINE="console=tty0 console=ttyS0,115200 root=/dev/sda rw vga=0x318"

if [ -n "$SNAPSHOT" ]; then
  DEBIAN_MIRROR="https://snapshot.debian.org/archive/debian/$SNAPSHOT"
  SECURITY_MIRROR="https://snapshot.debian.org/archive/debian-security/$SNAPSHOT"
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Le dossier de construction peut être déplacé hors du dépôt (par ex. sur un
# ext4 natif sous WSL) via LUMIBOOT_BUILD_DIR. Nécessaire car debootstrap et le
# chroot échouent sur les systèmes de fichiers 9p/DrvFs (/mnt/c) : l'extraction
# de certains paquets (ex. libpam-runtime) fait échouer tar. Par défaut, le
# comportement est inchangé (build/, build-desktop/ ou build-xfce/ dans le dépôt).
BUILD_DIR="${LUMIBOOT_BUILD_DIR:-$HERE/build$BUILD_SUFFIX}"
ROOTFS="$BUILD_DIR/rootfs"

# Paquets du socle commun (identiques à TOUS les flavors : la baseline console
# reste strictement la même).
BASE_PACKAGES="linux-image-686 initramfs-tools systemd-sysv systemd-resolved udev kmod \
bash coreutils util-linux mount login passwd sudo \
curl wget ca-certificates gnupg openssl \
tar gzip bzip2 xz-utils zstd zip unzip \
less nano vim-tiny file tree rsync git \
bash-completion gawk sed grep findutils procps psmisc man-db manpages htop \
iproute2 iputils-ping dnsutils \
python3 perl \
console-setup kbd locales"

# Paquets graphiques PARTAGÉS par les flavors desktop (Openbox) et xfce : pile
# Xorg minimale (serveur, pilotes, entrée, xinit, utilitaires), polices et bus
# D-Bus de session. Volontairement SANS GNOME/KDE ni Wayland.
#
# Pilote vidéo : sous v86 le noyau attache un pilote KMS `bochs-drm` (framebuffer
# /dev/fb0). Un pilote VBE (`vesa`) refuse alors de s'attacher et X échoue avec
# « no screens found ». On utilise donc `fbdev` (framebuffer noyau) en primaire
# et `modesetting` (KMS, fourni par `xserver-xorg-core`) en repli — voir
# guest/xorg.conf.d/20-lumiboot-fbdev.conf (fichier PARTAGÉ).
#
# `xserver-xorg-legacy` est conservé : il fournit le wrapper setuid
# `/usr/lib/xorg/Xorg.wrap` (+ `/etc/X11/Xwrapper.config`), requis car Xorg est
# lancé par le compte non privilégié « lumiboot » avec `needs_root_rights=yes`.
X_PACKAGES="xserver-xorg-core xserver-xorg-legacy xserver-xorg-video-vesa xserver-xorg-video-fbdev \
xserver-xorg-input-libinput xinit x11-xserver-utils x11-utils x11-xkb-utils xauth \
fonts-dejavu-core dbus-x11"

# Ajout propre au flavor desktop : Openbox + xterm (session de bureau minimale).
DESKTOP_PACKAGES="$X_PACKAGES xterm openbox"

# Ajout propre au flavor xfce : environnement de bureau XFCE complet. Pas de
# gestionnaire de connexion (lightdm/GDM) : démarrage direct via startx+~/.xinitrc.
XFCE_PACKAGES="$X_PACKAGES xfce4 xfce4-session xfwm4 xfconf xfce4-panel xfce4-terminal thunar"

PACKAGES="$BASE_PACKAGES"
case "$FLAVOR" in
  desktop) PACKAGES="$BASE_PACKAGES $DESKTOP_PACKAGES" ;;
  xfce) PACKAGES="$BASE_PACKAGES $XFCE_PACKAGES" ;;
esac

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Outil requis manquant : $1" >&2
    exit 1
  }
}

[ "$(uname -s)" = "Linux" ] || {
  echo "Ce script doit s'exécuter sous Linux ou WSL2." >&2
  exit 1
}
[ "$(id -u)" -eq 0 ] || {
  echo "Exécuter avec sudo : debootstrap et chroot nécessitent root." >&2
  exit 1
}

for tool in debootstrap mkfs.ext4 truncate sha256sum chroot e2fsck node; do require "$tool"; done
if [ "$(uname -m)" != "x86_64" ]; then
  require qemu-i386
  echo "Attention : hôte non x86_64, debootstrap i386 nécessite binfmt/qemu-user." >&2
fi

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

echo "== 1. debootstrap $RELEASE/$ARCH (minbase) — flavor=$FLAVOR =="
debootstrap --arch="$ARCH" --variant=minbase "$RELEASE" "$ROOTFS" "$DEBIAN_MIRROR"

echo "== 2. Configuration de base du rootfs =="
cat > "$ROOTFS/etc/apt/sources.list" <<EOF
deb $DEBIAN_MIRROR $RELEASE main
deb $DEBIAN_MIRROR $RELEASE-updates main
deb $SECURITY_MIRROR $RELEASE-security main
EOF

echo "lumiboot" > "$ROOTFS/etc/hostname"
cat > "$ROOTFS/etc/hosts" <<EOF
127.0.0.1   localhost lumiboot
::1         localhost
EOF
cat > "$ROOTFS/etc/fstab" <<EOF
/dev/sda   /   ext4   defaults,noatime   0 1
EOF

# Clavier français AZERTY : écrit AVANT l'installation pour que console-setup /
# keyboard-configuration le reprennent, et réécrit APRÈS (leur postinst peut
# régénérer ce fichier depuis debconf) pour garantir XKBLAYOUT="fr".
write_keyboard_config() {
  cat > "$1/etc/default/keyboard" <<'EOF'
XKBMODEL="pc105"
XKBLAYOUT="fr"
XKBVARIANT=""
XKBOPTIONS=""
BACKSPACE="guess"
EOF
}
write_keyboard_config "$ROOTFS"

# Pré-réponses debconf : évite tout prompt clavier/locale en noninteractif.
cat > "$ROOTFS/tmp/lumiboot-preseed.txt" <<'EOF'
keyboard-configuration keyboard-configuration/modelcode string pc105
keyboard-configuration keyboard-configuration/layoutcode string fr
keyboard-configuration keyboard-configuration/variantcode string
keyboard-configuration keyboard-configuration/optionscode string
console-setup console-setup/charmap47 select UTF-8
EOF

cat > "$ROOTFS/etc/apt/apt.conf.d/99lumiboot" <<EOF
APT::Install-Recommends "false";
APT::Install-Suggests "false";
EOF

echo "== 3. Montages chroot =="
mount_pseudo() {
  if [ -e "$1" ]; then
    mkdir -p "$ROOTFS$2"
    mount --bind "$1" "$ROOTFS$2"
  fi
}
cleanup_mounts() {
  for m in dev/pts dev proc sys; do
    if mountpoint -q "$ROOTFS/$m"; then umount -lf "$ROOTFS/$m" || true; fi
  done
}
trap cleanup_mounts EXIT

mount_pseudo /dev "$ROOTFS/dev"
mount_pseudo /dev/pts "$ROOTFS/dev/pts"
mount -t proc proc "$ROOTFS/proc"
mount -t sysfs sys "$ROOTFS/sys"

echo "== 4. Installation des paquets (socle commun + flavor $FLAVOR) =="
chroot "$ROOTFS" env PACKAGES="$PACKAGES" bash -e -c '
  export DEBIAN_FRONTEND=noninteractive
  if command -v debconf-set-selections >/dev/null 2>&1; then
    debconf-set-selections /tmp/lumiboot-preseed.txt
  fi
  apt-get update
  apt-get install -y --no-install-recommends \
    -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" \
    $PACKAGES
'
rm -f "$ROOTFS/tmp/lumiboot-preseed.txt"

echo "== 4b. Clavier fr + locales fr_FR/en_US =="
# Réécriture ferme après install (postinst console-setup peut l'avoir régénéré).
write_keyboard_config "$ROOTFS"
sed -i 's/^# *\(fr_FR.UTF-8 UTF-8\)/\1/' "$ROOTFS/etc/locale.gen"
sed -i 's/^# *\(en_US.UTF-8 UTF-8\)/\1/' "$ROOTFS/etc/locale.gen"
grep -qxF 'fr_FR.UTF-8 UTF-8' "$ROOTFS/etc/locale.gen" || echo 'fr_FR.UTF-8 UTF-8' >> "$ROOTFS/etc/locale.gen"
grep -qxF 'en_US.UTF-8 UTF-8' "$ROOTFS/etc/locale.gen" || echo 'en_US.UTF-8 UTF-8' >> "$ROOTFS/etc/locale.gen"
chroot "$ROOTFS" locale-gen
printf 'LANG=fr_FR.UTF-8\n' > "$ROOTFS/etc/default/locale"

echo "== 4c. vim : exposer /usr/bin/vim (vim-tiny ne fournit que vim.tiny) =="
if [ -x "$ROOTFS/usr/bin/vim.tiny" ] && [ ! -e "$ROOTFS/usr/bin/vim" ]; then
  chroot "$ROOTFS" update-alternatives --install /usr/bin/vim vim /usr/bin/vim.tiny 10
fi

# ── 4d. Pile graphique (flavors graphiques : desktop et xfce) ────────────────
if [ "$GRAPHICAL" = "true" ]; then
  echo "== 4d. Pile graphique Xorg / gestionnaire de session =="
  # Pilote vidéo : le noyau attache KMS « bochs-drm » (framebuffer /dev/fb0). On
  # définit DEUX ServerLayout (fbdev primaire, modesetting en repli), sélectionnés
  # par /usr/local/bin/lumiboot-startx. « vesa » n'est plus utilisé (il refuse de
  # s'attacher quand un pilote KMS est lié → « no screens found »). Cette
  # configuration est PARTAGÉE par desktop et xfce (un seul fichier source).
  install -d -m 0755 "$ROOTFS/etc/X11/xorg.conf.d"
  install -D -m 0644 "$HERE/guest/xorg.conf.d/20-lumiboot-fbdev.conf" \
    "$ROOTFS/etc/X11/xorg.conf.d/20-lumiboot-fbdev.conf"

  # Xwrapper.config : autorise un lancement de Xorg par le compte NON
  # privilégié « lumiboot » avec des droits root (needs_root_rights=yes). Le
  # wrapper setuid Xorg.wrap vient de xserver-xorg-legacy. La SESSION (Openbox ou
  # XFCE) reste, elle, non privilégiée.
  cat > "$ROOTFS/etc/X11/Xwrapper.config" <<'EOF'
# Configuration du wrapper Xorg (xserver-xorg-legacy) pour v86.
# Le serveur X doit disposer des droits root (needs_root_rights=yes) pour
# piloter le framebuffer noyau /dev/fb0, tandis que le lancement par
# l'utilisateur « lumiboot » doit être autorisé (allowed_users). Sans le bit
# setuid de Xorg.wrap, Xorg échoue avec « no screens found ».
allowed_users=anybody
needs_root_rights=yes
EOF
  chmod 0644 "$ROOTFS/etc/X11/Xwrapper.config"

  # Ceinture et bretelles : le paquet installe Xorg.wrap en 6755 (setuid+setgid).
  # On (re)pose le bit setuid pour ne jamais livrer une image où Xorg ne peut pas
  # piloter le framebuffer noyau — cause possible du « no screens found ».
  if [ -e "$ROOTFS/usr/lib/xorg/Xorg.wrap" ]; then
    chmod u+s "$ROOTFS/usr/lib/xorg/Xorg.wrap"
  fi

  # Lanceur de session : tente « fbdev » puis « modesetting » en repli (partagé
  # desktop/xfce ; le choix de la session est fait par ~/.xinitrc du flavor).
  install -D -m 0755 "$HERE/guest/lumiboot-startx" \
    "$ROOTFS/usr/local/bin/lumiboot-startx"
fi

echo "== 5. initramfs : pilotes stockage/FS émulés =="
cat > "$ROOTFS/etc/initramfs-tools/modules" <<EOF
ext4
ata_piix
ata_generic
sd_mod
EOF
sed -i 's/^MODULES=.*/MODULES=most/' "$ROOTFS/etc/initramfs-tools/initramfs.conf" 2>/dev/null || true

echo "== 6. Utilisateur non privilégié + console série =="
chroot "$ROOTFS" bash -e -c '
  if ! id lumiboot >/dev/null 2>&1; then
    useradd --create-home --shell /bin/bash lumiboot
  fi
  passwd -d lumiboot >/dev/null
  # Accès en lecture/écriture au framebuffer noyau /dev/fb0 (groupe « video »),
  # requis par le pilote X « fbdev » du flavor desktop (inutile en console).
  if getent group video >/dev/null 2>&1; then
    usermod -aG video lumiboot
  fi
'

install -D -m 0644 "$HERE/guest/serial-getty-autologin.conf" \
  "$ROOTFS/etc/systemd/system/serial-getty@ttyS0.service.d/autologin.conf"
install -D -m 0644 "$HERE/guest/getty-autologin.conf" \
  "$ROOTFS/etc/systemd/system/getty@tty1.service.d/autologin.conf"
# Console VGA texte : le flavor minimal blackliste le DRM `bochs` pour rester en
# mode texte (vérifications `vga-console`). Les flavors graphiques (desktop,
# xfce) veulent au contraire un framebuffer RÉEL /dev/fb0 (repli Xorg `fbdev`) :
# sous v86 le seul fournisseur de framebuffer est `bochs-drm` (le noyau Debian
# 6.1 n'honore plus `vga=` au démarrage). On ne blackliste donc PAS `bochs` en
# desktop/xfce.
if [ "$FLAVOR" = "minimal" ]; then
  install -D -m 0644 "$HERE/guest/no-drm.conf" \
    "$ROOTFS/etc/modprobe.d/lumiboot-no-drm.conf"
fi

# Marqueur GUEST_READY : même unité « lumiboot-ready.service » pour les deux
# flavors, contenu adapté (référence d'image différente).
if [ -n "$READY_SERVICE_SRC" ]; then
  install -D -m 0644 "$HERE/guest/$READY_SERVICE_SRC" \
    "$ROOTFS/etc/systemd/system/lumiboot-ready.service"
else
  install -D -m 0644 "$HERE/guest/lumiboot-ready.service" \
    "$ROOTFS/etc/systemd/system/lumiboot-ready.service"
fi

# Session graphique (flavors desktop/xfce) : autologin tty1 → ~/.bash_profile
# lance startx → ~/.xinitrc démarre la session (Openbox ou XFCE). Le marqueur
# DESKTOP_READY n'est émis qu'après vérification réelle du serveur X et de la
# session. Les overlays proviennent du dossier `guest/<flavor>/`.
if [ "$GRAPHICAL" = "true" ]; then
  install -D -m 0755 "$HERE/guest/$GUEST_DIR/lumiboot-desktop-ready.sh" \
    "$ROOTFS/usr/local/bin/lumiboot-desktop-ready"
  install -D -m 0644 "$HERE/guest/$GUEST_DIR/lumiboot-desktop-ready.service" \
    "$ROOTFS/etc/systemd/system/lumiboot-desktop-ready.service"
  install -D -m 0644 "$HERE/guest/$GUEST_DIR/bash_profile" "$ROOTFS/home/lumiboot/.bash_profile"
  install -D -m 0755 "$HERE/guest/$GUEST_DIR/xinitrc" "$ROOTFS/home/lumiboot/.xinitrc"
  chroot "$ROOTFS" chown lumiboot:lumiboot /home/lumiboot/.bash_profile /home/lumiboot/.xinitrc
fi

chroot "$ROOTFS" bash -e -c '
  systemctl enable serial-getty@ttyS0.service
  systemctl enable getty@tty1.service
  systemctl enable lumiboot-ready.service
  if [ -f /lib/systemd/system/keyboard-setup.service ]; then
    systemctl enable keyboard-setup.service
  fi
  if [ -f /lib/systemd/system/console-setup.service ]; then
    systemctl enable console-setup.service
  fi
'
if [ "$GRAPHICAL" = "true" ]; then
  chroot "$ROOTFS" systemctl enable lumiboot-desktop-ready.service
fi

# Debian active keyboard-setup.service via sysinit.target.wants (WantedBy
# =sysinit.target) ; on ajoute aussi le lien multi-user.target.wants attendu
# par la vérification d'acceptation. Sans effet double : unité oneshot.
ln -sf /lib/systemd/system/keyboard-setup.service \
  "$ROOTFS/etc/systemd/system/multi-user.target.wants/keyboard-setup.service"

echo "== 6b. sudo NOPASSWD pour lumiboot =="
printf "%s\n" "lumiboot ALL=(ALL) NOPASSWD:ALL" > "$ROOTFS/etc/sudoers.d/90-lumiboot"
chmod 0440 "$ROOTFS/etc/sudoers.d/90-lumiboot"
chroot "$ROOTFS" bash -e -c '
  if command -v visudo >/dev/null 2>&1; then
    visudo -cf /etc/sudoers.d/90-lumiboot
  fi
'

echo "== 6c. Réseau invité : DHCP (systemd-networkd) + DNS (systemd-resolved) =="
# L'image minbase ne configure AUCUN réseau : la carte virtio v86 (enp0s10)
# est détectée mais reste DOWN, sans bail DHCP ni résolveur. On active donc
# networkd (DHCP v4 sur les interfaces filaires) et resolved (DNS).
# systemd-networkd est fourni par le paquet `systemd` ; resolved par
# `systemd-resolved` (installé à l'étape 4).
install -d -m 0755 "$ROOTFS/etc/systemd/network"
cat > "$ROOTFS/etc/systemd/network/20-lumiboot.network" <<'EOF'
# Interface filaire émulée par v86 (virtio-net, enp0s10). `Name=en*` couvre
# les noms prévisibles (enp0s10, ens3…) ; `eth*` sert de repli pour eth0.
[Match]
Name=en* eth*

[Network]
DHCP=ipv4

# Le serveur DHCP virtuel de v86 (backend « fetch ») renvoie un DHCPOFFER
# SANS option 51 (durée du bail). Le client DHCPv4 de systemd (≥ v250) rejette
# alors le bail (« received lease lacks address, server address or lease
# lifetime ») et ne configure jamais l'interface. Debian bookworm embarque un
# systemd 252 qui sait poser un bail de repli : on l'autorise explicitement.
# (systemd n'accepte que « forever » ou « infinity » ici.)
[DHCPv4]
FallbackLeaseLifetimeSec=infinity
EOF

chroot "$ROOTFS" bash -e -c '
  systemctl enable systemd-networkd.service
  systemctl enable systemd-resolved.service
'

echo "== 7. Régénération de l'initramfs =="
chroot "$ROOTFS" update-initramfs -u -k all

echo "== 8. Extraction noyau + initrd (même version) =="
# Format par défaut de `dpkg-query -W` = "Paquet<TAB>Version" : pas de -f,
# donc aucun `$` à échapper à travers les couches de shell/chroot.
chroot "$ROOTFS" env PACKAGES="$PACKAGES" bash -c 'dpkg-query -W $PACKAGES' \
  > "$BUILD_DIR/packages.tsv" 2>/dev/null || true

echo "== 8b. Vérification in-rootfs (outils, clavier, locale, graphique) =="
chroot "$ROOTFS" env FLAVOR="$FLAVOR" bash -c '
  for tool in curl wget git vim nano ping dig python3 perl htop tree rsync zstd unzip less file; do
    if command -v "$tool" >/dev/null 2>&1; then
      echo "OK   $tool -> $(command -v "$tool")"
    else
      echo "MISS $tool"
    fi
  done
  echo "--- /etc/default/keyboard"; cat /etc/default/keyboard
  if systemctl is-enabled keyboard-setup.service 2>/dev/null | grep -qx enabled; then
    echo "keyboard-setup.service: ENABLED"
  else
    echo "keyboard-setup.service: NOT ENABLED"
  fi
  ls -l /etc/systemd/system/sysinit.target.wants/keyboard-setup.service \
        /etc/systemd/system/multi-user.target.wants/keyboard-setup.service 2>/dev/null || true
  echo "--- locales générées"; locale -a | grep -iE "fr_FR|en_US" || echo "(aucune)"
  echo "--- os-release"; grep PRETTY_NAME /etc/os-release
  echo "--- réseau invité"
  cat /etc/systemd/network/20-lumiboot.network 2>/dev/null || echo "MISS 20-lumiboot.network"
  for unit in systemd-networkd.service systemd-resolved.service; do
    if systemctl is-enabled "$unit" 2>/dev/null | grep -qx enabled; then
      echo "$unit: ENABLED"
    else
      echo "$unit: NOT ENABLED"
    fi
  done
  test -x /lib/systemd/systemd-networkd && echo "systemd-networkd: present" || echo "systemd-networkd: MISSING"
  test -x /lib/systemd/systemd-resolved && echo "systemd-resolved: present" || echo "systemd-resolved: MISSING"

  if [ "$FLAVOR" = "desktop" ] || [ "$FLAVOR" = "xfce" ]; then
    echo "--- pile graphique"
    if [ "$FLAVOR" = "xfce" ]; then
      GRAPHICAL_BINS="Xorg startx startxfce4 xfce4-session xfwm4 xdpyinfo"
    else
      GRAPHICAL_BINS="Xorg startx xterm openbox xdpyinfo"
    fi
    for b in $GRAPHICAL_BINS; do
      if command -v "$b" >/dev/null 2>&1; then
        echo "OK   $b -> $(command -v "$b")"
      else
        echo "MISS $b"
      fi
    done
    for u in lumiboot-ready.service lumiboot-desktop-ready.service; do
      if systemctl is-enabled "$u" 2>/dev/null | grep -qx enabled; then
        echo "$u: ENABLED"
      else
        echo "$u: NOT ENABLED"
      fi
    done
    test -x /usr/local/bin/lumiboot-desktop-ready && echo "lumiboot-desktop-ready: present" || echo "lumiboot-desktop-ready: MISSING"
    test -x /usr/local/bin/lumiboot-startx && echo "lumiboot-startx: present" || echo "lumiboot-startx: MISSING"
    ls -l /home/lumiboot/.xinitrc /home/lumiboot/.bash_profile /etc/X11/xorg.conf.d/20-lumiboot-fbdev.conf
    echo "--- pilotes X fbdev / modesetting ---"
    test -e /usr/lib/xorg/modules/drivers/fbdev_drv.so && echo "fbdev_drv.so: present" || echo "fbdev_drv.so: MISSING" >&2
    test -e /usr/lib/xorg/modules/drivers/modesetting_drv.so && echo "modesetting_drv.so: present" || echo "modesetting_drv.so: MISSING (fourni par xserver-xorg-core)" >&2
    echo "--- wrapper Xorg setuid (framebuffer noyau /dev/fb0) ---"
    ls -l /usr/lib/xorg/Xorg.wrap /etc/X11/Xwrapper.config 2>/dev/null || true
    cat /etc/X11/Xwrapper.config 2>/dev/null || echo "MISS Xwrapper.config"
    if [ -u /usr/lib/xorg/Xorg.wrap ]; then
      echo "Xorg.wrap setuid: OK"
    else
      echo "Xorg.wrap setuid: MANQUANT (Xorg ne pourra pas piloter le framebuffer)" >&2
      exit 1
    fi
    echo "--- groupes de lumiboot (video requis pour /dev/fb0) ---"
    id lumiboot
  fi
'

KERNEL_VERSION="$(ls "$ROOTFS/boot" | sed -n 's/^vmlinuz-\(.*\)$/\1/p' | head -n1)"
[ -n "${KERNEL_VERSION:-}" ] || { echo "Noyau introuvable dans $ROOTFS/boot." >&2; exit 1; }
cp "$ROOTFS/boot/vmlinuz-$KERNEL_VERSION" "$BUILD_DIR/vmlinuz-686"
cp "$ROOTFS/boot/initrd.img-$KERNEL_VERSION" "$BUILD_DIR/initrd.img"

cleanup_mounts
trap - EXIT

echo "== 8c. resolv.conf : resolv.conf systemd-resolved (retire le fichier WSL de l'hôte) =="
# debootstrap/apt ont copié le /etc/resolv.conf de l'HÔTE (« generated by WSL,
# nameserver 10.255.255.254 ») : périmé et inutile dans l'invité. On le
# remplace EN DERNIER (après toutes les installs qui ont besoin du DNS de
# l'hôte) par un lien vers le resolv.conf « amont » de systemd-resolved,
# recréé à chaque boot. On pointe l'amont (et non le stub 127.0.0.53) pour
# que `cat /etc/resolv.conf` expose directement le DNS fourni par le DHCP
# virtuel de v86 (ex. 192.168.86.1).
rm -f "$ROOTFS/etc/resolv.conf"
ln -sf /run/systemd/resolve/resolv.conf "$ROOTFS/etc/resolv.conf"
ls -l "$ROOTFS/etc/resolv.conf"

echo "== 9. Image disque ext4 brute ($DISK_SIZE) =="
truncate -s "$DISK_SIZE" "$BUILD_DIR/rootfs.img"
mkfs.ext4 -F -L lumiboot -d "$ROOTFS" "$BUILD_DIR/rootfs.img"
e2fsck -fn "$BUILD_DIR/rootfs.img"

# Vérification post-copie : `mkfs.ext4 -d` DOIT préserver le bit setuid de
# Xorg.wrap (extraction/copie de l'arbre sans perte de permissions). On le
# contrôle directement DANS l'image produite, pas seulement dans le chroot.
if [ "$GRAPHICAL" = "true" ]; then
  echo "== 9b. Contrôle du bit setuid dans rootfs.img (debugfs) =="
  if debugfs -R 'stat /usr/lib/xorg/Xorg.wrap' "$BUILD_DIR/rootfs.img" 2>/dev/null | grep -qE 'Mode: *0?[4-7][0-7]{3}'; then
    echo "Xorg.wrap dans rootfs.img : setuid présent"
  else
    debugfs -R 'stat /usr/lib/xorg/Xorg.wrap' "$BUILD_DIR/rootfs.img" 2>&1 | sed -n '1,6p' || true
    echo "Xorg.wrap dans rootfs.img : setuid ABSENT (X échouerait sous v86)." >&2
    exit 1
  fi
fi

echo "== 10. Manifeste + provenance (tailles + SHA réels) =="
# Les flavors graphiques (desktop, xfce) publient une cmdline noyau propre
# (framebuffer VBE pour le repli Xorg fbdev) ; le flavor minimal ne l'émet pas
# et garde le défaut du provider (console texte) — comportement inchangé.
MANIFEST_CMDLINE=""
if [ "$GRAPHICAL" = "true" ]; then
  MANIFEST_CMDLINE="$DESKTOP_CMDLINE"
fi
IMAGE_REF="$REF" IMAGE_ARCH="$ARCH" IMAGE_MEMORY_MIB="$MEMORY_MIB" IMAGE_VGA_MIB="$VGA_MIB" \
  IMAGE_CMDLINE="$MANIFEST_CMDLINE" \
  node "$HERE/write-manifest.mjs" "$BUILD_DIR"

{
  echo "flavor: $FLAVOR"
  echo "image-ref: $REF"
  echo "release: $RELEASE"
  echo "architecture: $ARCH"
  echo "mirror: $DEBIAN_MIRROR"
  echo "security-mirror: $SECURITY_MIRROR"
  echo "snapshot: ${SNAPSHOT:-aucun (miroir vivant)}"
  echo "debootstrap: $(debootstrap --version 2>/dev/null | head -n1 || echo inconnu)"
  echo "built-utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "note: les SHA-256 réels des artefacts sont dans manifest.json."
  echo "note: ce build N'A PAS été exécuté dans l'environnement de développement (aucune image réelle)."
} > "$BUILD_DIR/provenance.txt"
cat "$BUILD_DIR/provenance.txt"

cat <<EOF

Construction terminée (flavor=$FLAVOR, ref=$REF).

Pour publier dans l'application :
  cp "$BUILD_DIR/rootfs.img"           "$HERE/../../apps/web/public/images/$REF/"
  cp "$BUILD_DIR/vmlinuz-686"          "$HERE/../../apps/web/public/images/$REF/"
  cp "$BUILD_DIR/initrd.img"           "$HERE/../../apps/web/public/images/$REF/"
  cp "$BUILD_DIR/manifest.json"        "$HERE/../../apps/web/public/images/$REF/"

Vérifiez ensuite les requêtes HTTP Range puis le smoke test réel.
Pour le flavor minimal : images/debian-12-i386/tests/boot-smoke-test.md
Pour le flavor desktop : images/debian-12-i386/tests/desktop-smoke-test.md
Pour le flavor xfce    : images/debian-12-i386/tests/xfce-smoke-test.md

Ne passer un système à availability:'ready' (et v86.integrated à true) qu'APRÈS
un boot réellement prouvé (voir docs/debian-desktop.md et docs/debian-xfce.md).
EOF
