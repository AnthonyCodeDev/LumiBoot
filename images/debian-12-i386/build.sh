#!/usr/bin/env bash
#
# Construction reproductible d'une image Debian 12 Bookworm i386 pour v86.
#
#   sudo ./images/debian-12-i386/build.sh              # flavor « minimal » (console, défaut)
#   sudo FLAVOR=desktop ./images/debian-12-i386/build.sh   # flavor « desktop » (Xorg + Openbox)
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
# Deux flavors partagent le MÊME socle ci-dessous (aucun copier-coller) :
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
#
#     Les deux marqueurs sont émis par le système INVITÉ via systemd (voir
#     guest/), jamais par JavaScript, et écrits sur la console série (ttyS0).
#
# Résultat dans images/debian-12-i386/build[-desktop]/ :
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
    ;;
  desktop)
    REF="debian-12-i386-desktop"
    MEMORY_MIB="1024"
    VGA_MIB="16"
    BUILD_SUFFIX="-desktop"
    READY_SERVICE_SRC="desktop/lumiboot-ready.service"
    ;;
  *)
    echo "Flavor inconnu : « $FLAVOR » (attendu : minimal | desktop)." >&2
    exit 1
    ;;
esac

RELEASE="bookworm"
ARCH="i386"
DEBIAN_MIRROR="${DEBIAN_MIRROR:-https://deb.debian.org/debian}"
SECURITY_MIRROR="${SECURITY_MIRROR:-http://security.debian.org/debian-security}"
# Snapshot daté optionnel (format snapshot.debian.org : 20240101T000000Z).
SNAPSHOT="${SNAPSHOT:-}"
DISK_SIZE="${DISK_SIZE:-3G}"

if [ -n "$SNAPSHOT" ]; then
  DEBIAN_MIRROR="https://snapshot.debian.org/archive/debian/$SNAPSHOT"
  SECURITY_MIRROR="https://snapshot.debian.org/archive/debian-security/$SNAPSHOT"
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$HERE/build$BUILD_SUFFIX"
ROOTFS="$BUILD_DIR/rootfs"

# Paquets du socle commun (identiques aux deux flavors : la baseline console
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

# Paquets additionnels du flavor desktop : Xorg minimal + Openbox + xterm.
# Volontairement SANS GNOME/KDE ni Wayland. Le pilote vidéo vise VBE (vesa) et
# le framebuffer (fbdev) : v86 n'expose ni accélération ni DRM utilisable ici.
DESKTOP_PACKAGES="xserver-xorg-core xserver-xorg-video-vesa xserver-xorg-video-fbdev \
xserver-xorg-input-libinput xinit x11-xserver-utils x11-utils x11-xkb-utils xauth \
xterm openbox fonts-dejavu-core dbus-x11"

PACKAGES="$BASE_PACKAGES"
if [ "$FLAVOR" = "desktop" ]; then
  PACKAGES="$BASE_PACKAGES $DESKTOP_PACKAGES"
fi

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

# ── 4d. Pile graphique (flavor desktop uniquement) ───────────────────────────
if [ "$FLAVOR" = "desktop" ]; then
  echo "== 4d. Pile graphique Xorg/Openbox =="
  # Pilote vidéo : sous v86 il n'y a pas de DRM exploitable, on force VBE
  # (« vesa ») ; « fbdev » reste disponible en repli si un framebuffer existe.
  install -d -m 0755 "$ROOTFS/etc/X11/xorg.conf.d"
  install -D -m 0644 "$HERE/guest/desktop/xorg.conf.d/20-lumiboot-vesa.conf" \
    "$ROOTFS/etc/X11/xorg.conf.d/20-lumiboot-vesa.conf"
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
'

install -D -m 0644 "$HERE/guest/serial-getty-autologin.conf" \
  "$ROOTFS/etc/systemd/system/serial-getty@ttyS0.service.d/autologin.conf"
install -D -m 0644 "$HERE/guest/getty-autologin.conf" \
  "$ROOTFS/etc/systemd/system/getty@tty1.service.d/autologin.conf"
install -D -m 0644 "$HERE/guest/no-drm.conf" \
  "$ROOTFS/etc/modprobe.d/lumiboot-no-drm.conf"

# Marqueur GUEST_READY : même unité « lumiboot-ready.service » pour les deux
# flavors, contenu adapté (référence d'image différente).
if [ -n "$READY_SERVICE_SRC" ]; then
  install -D -m 0644 "$HERE/guest/$READY_SERVICE_SRC" \
    "$ROOTFS/etc/systemd/system/lumiboot-ready.service"
else
  install -D -m 0644 "$HERE/guest/lumiboot-ready.service" \
    "$ROOTFS/etc/systemd/system/lumiboot-ready.service"
fi

# Session graphique (flavor desktop) : autologin tty1 → ~/.bash_profile lance
# startx → ~/.xinitrc démarre Openbox + un xterm. Le marqueur DESKTOP_READY
# n'est émis qu'après vérification réelle du serveur X et de la session.
if [ "$FLAVOR" = "desktop" ]; then
  install -D -m 0755 "$HERE/guest/desktop/lumiboot-desktop-ready.sh" \
    "$ROOTFS/usr/local/bin/lumiboot-desktop-ready"
  install -D -m 0644 "$HERE/guest/desktop/lumiboot-desktop-ready.service" \
    "$ROOTFS/etc/systemd/system/lumiboot-desktop-ready.service"
  install -D -m 0644 "$HERE/guest/desktop/bash_profile" "$ROOTFS/home/lumiboot/.bash_profile"
  install -D -m 0755 "$HERE/guest/desktop/xinitrc" "$ROOTFS/home/lumiboot/.xinitrc"
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
if [ "$FLAVOR" = "desktop" ]; then
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

  if [ "$FLAVOR" = "desktop" ]; then
    echo "--- pile graphique"
    for b in Xorg startx xterm openbox; do
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
    ls -l /home/lumiboot/.xinitrc /home/lumiboot/.bash_profile /etc/X11/xorg.conf.d/20-lumiboot-vesa.conf
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

echo "== 10. Manifeste + provenance (tailles + SHA réels) =="
IMAGE_REF="$REF" IMAGE_ARCH="$ARCH" IMAGE_MEMORY_MIB="$MEMORY_MIB" IMAGE_VGA_MIB="$VGA_MIB" \
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

Ne passer un système à availability:'ready' (et v86.integrated à true) qu'APRÈS
un boot réellement prouvé. Le flavor desktop n'est PAS prêt par défaut.
EOF
