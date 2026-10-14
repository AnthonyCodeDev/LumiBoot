#!/usr/bin/env bash
#
# Construction reproductible de l'image Debian 12 Bookworm i386 pour v86.
#
# À exécuter sous Linux ou WSL2, jamais sous Windows natif ni dans un pipeline
# qui n'a pas debootstrap. Ne committe jamais les binaires produits.
#
#   sudo ./images/debian-12-i386/build.sh
#
# Résultat dans images/debian-12-i386/build/ :
#   rootfs.img      disque ext4 brut (racine Debian)
#   vmlinuz-686     noyau (bzimage) de la même version que l'initrd
#   initrd.img      initramfs correspondant
#   manifest.json   tailles + SHA-256 réels (schéma strict @lumiboot/vm-assets)
#   packages.tsv    versions réellement installées (traçabilité)
#
# Le marqueur de disponibilité LUMIBOOT_GUEST_READY:debian-12-i386 est émis par
# le système invité via systemd (voir guest/), jamais par JavaScript.
set -euo pipefail

RELEASE="bookworm"
ARCH="i386"
DEBIAN_MIRROR="${DEBIAN_MIRROR:-https://deb.debian.org/debian}"
DISK_SIZE="${DISK_SIZE:-3G}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$HERE/build"
ROOTFS="$BUILD_DIR/rootfs"

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

echo "== 1. debootstrap $RELEASE/$ARCH (minbase) =="
debootstrap --arch="$ARCH" --variant=minbase "$RELEASE" "$ROOTFS" "$DEBIAN_MIRROR"

echo "== 2. Configuration de base du rootfs =="
cat > "$ROOTFS/etc/apt/sources.list" <<EOF
deb $DEBIAN_MIRROR $RELEASE main
deb $DEBIAN_MIRROR $RELEASE-updates main
deb http://security.debian.org/debian-security $RELEASE-security main
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

echo "== 4. Installation des paquets (socle utilisable + clavier + locale) =="
chroot "$ROOTFS" bash -e -c '
  export DEBIAN_FRONTEND=noninteractive
  if command -v debconf-set-selections >/dev/null 2>&1; then
    debconf-set-selections /tmp/lumiboot-preseed.txt
  fi
  apt-get update
  apt-get install -y --no-install-recommends \
    -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" \
    linux-image-686 initramfs-tools systemd-sysv systemd-resolved udev kmod \
    bash coreutils util-linux mount login passwd sudo \
    curl wget ca-certificates gnupg openssl \
    tar gzip bzip2 xz-utils zstd zip unzip \
    less nano vim-tiny file tree rsync git \
    bash-completion gawk sed grep findutils procps psmisc man-db manpages htop \
    iproute2 iputils-ping dnsutils \
    python3 perl \
    console-setup kbd locales
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
install -D -m 0644 "$HERE/guest/lumiboot-ready.service" \
  "$ROOTFS/etc/systemd/system/lumiboot-ready.service"
install -D -m 0644 "$HERE/guest/no-drm.conf" \
  "$ROOTFS/etc/modprobe.d/lumiboot-no-drm.conf"

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
chroot "$ROOTFS" dpkg-query -W \
  linux-image-686 initramfs-tools systemd-sysv systemd-resolved udev kmod \
  bash coreutils util-linux mount login passwd sudo \
  curl wget ca-certificates gnupg openssl \
  tar gzip bzip2 xz-utils zstd zip unzip \
  less nano vim-tiny file tree rsync git \
  bash-completion gawk sed grep findutils procps psmisc man-db manpages htop \
  iproute2 iputils-ping dnsutils \
  python3 perl console-setup kbd locales \
  > "$BUILD_DIR/packages.tsv" 2>/dev/null || true

echo "== 8b. Vérification in-rootfs (outils, clavier, locale) =="
chroot "$ROOTFS" bash -c '
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

echo "== 10. Manifeste (tailles + SHA réels) =="
node "$HERE/write-manifest.mjs" "$BUILD_DIR"

cat <<EOF

Construction terminée.

Pour publier dans l'application :
  cp "$BUILD_DIR/rootfs.img"           "$HERE/../../apps/web/public/images/debian-12-i386/"
  cp "$BUILD_DIR/vmlinuz-686"          "$HERE/../../apps/web/public/images/debian-12-i386/"
  cp "$BUILD_DIR/initrd.img"           "$HERE/../../apps/web/public/images/debian-12-i386/"
  cp "$BUILD_DIR/manifest.json"        "$HERE/../../apps/web/public/images/debian-12-i386/"

Vérifiez ensuite les requêtes HTTP Range puis le smoke test réel
(images/debian-12-i386/tests/boot-smoke-test.md) AVANT de passer Debian
à availability:'ready' et v86.integrated à true.
EOF
