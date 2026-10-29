#!/usr/bin/env bash
#
# Reproducible build of a Debian 12 Bookworm i386 image for v86.
#
#   sudo ./images/debian-12-i386/build.sh                 # minimal flavor
#   sudo FLAVOR=desktop ./images/debian-12-i386/build.sh
#   sudo FLAVOR=xfce SNAPSHOT=20240101T000000Z ./images/debian-12-i386/build.sh
#
# Requires Linux or WSL2, root, debootstrap, and qemu-i386 on a non-x86_64 host.
# DISK_SIZE and LUMIBOOT_BUILD_DIR override the disk size and the build directory.
# Writes rootfs.img, vmlinuz-686, initrd.img, manifest.json, packages.tsv and
# provenance.txt into build/, build-desktop/ or build-xfce/.
set -euo pipefail

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
    # XFCE is much larger: its disk defaults to 4 GiB.
    DISK_SIZE_DEFAULT="4G"
    ;;
  *)
    echo "Unknown flavor: \"$FLAVOR\" (expected: minimal | desktop | xfce)." >&2
    exit 1
    ;;
esac

GRAPHICAL=""
if [ "$FLAVOR" = "desktop" ] || [ "$FLAVOR" = "xfce" ]; then
  GRAPHICAL="true"
fi

RELEASE="bookworm"
ARCH="i386"
DEBIAN_MIRROR="${DEBIAN_MIRROR:-https://deb.debian.org/debian}"
SECURITY_MIRROR="${SECURITY_MIRROR:-http://security.debian.org/debian-security}"
# Optional dated snapshot, snapshot.debian.org format.
SNAPSHOT="${SNAPSHOT:-}"
DISK_SIZE="${DISK_SIZE:-$DISK_SIZE_DEFAULT}"

# Graphical flavors force the VBE framebuffer: under v86 there is no DRM, and
# /dev/fb0 is required by the Xorg fbdev fallback.
DESKTOP_CMDLINE="console=tty0 console=ttyS0,115200 root=/dev/sda rw vga=0x318"

if [ -n "$SNAPSHOT" ]; then
  DEBIAN_MIRROR="https://snapshot.debian.org/archive/debian/$SNAPSHOT"
  SECURITY_MIRROR="https://snapshot.debian.org/archive/debian-security/$SNAPSHOT"
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The build directory can live on a native ext4 filesystem outside the
# repository: debootstrap and chroot fail on 9p/DrvFs mounts.
DEFAULT_BUILD_DIR="$(realpath -m -- "$HERE/build$BUILD_SUFFIX")"
BUILD_DIR="$(realpath -m -- "${LUMIBOOT_BUILD_DIR:-$DEFAULT_BUILD_DIR}")"
ROOTFS="$BUILD_DIR/rootfs"

BASE_PACKAGES="linux-image-686 initramfs-tools systemd-sysv systemd-resolved udev kmod \
bash coreutils util-linux mount login passwd sudo \
curl wget ca-certificates gnupg openssl \
tar gzip bzip2 xz-utils zstd zip unzip \
less nano vim-tiny file tree rsync git \
bash-completion gawk sed grep findutils procps psmisc man-db manpages htop \
iproute2 iputils-ping dnsutils \
python3 perl \
console-setup kbd locales"

# Xorg stack shared by the desktop and xfce flavors, without GNOME, KDE or Wayland.
# Under v86 the kernel binds a bochs-drm KMS driver: vesa cannot attach, fbdev is
# primary and modesetting the fallback, and legacy provides the setuid Xorg.wrap.
X_PACKAGES="xserver-xorg-core xserver-xorg-legacy xserver-xorg-video-vesa xserver-xorg-video-fbdev \
xserver-xorg-input-libinput xinit x11-xserver-utils x11-utils x11-xkb-utils xauth \
fonts-dejavu-core dbus-x11"

DESKTOP_PACKAGES="$X_PACKAGES xterm openbox"

# XFCE addition: full desktop, started directly through startx, without a display manager.
XFCE_PACKAGES="$X_PACKAGES xfce4 xfce4-session xfwm4 xfconf xfce4-panel xfce4-terminal thunar"

PACKAGES="$BASE_PACKAGES"
case "$FLAVOR" in
  desktop) PACKAGES="$BASE_PACKAGES $DESKTOP_PACKAGES" ;;
  xfce) PACKAGES="$BASE_PACKAGES $XFCE_PACKAGES" ;;
esac

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required tool: $1" >&2
    exit 1
  }
}

[ "$(uname -s)" = "Linux" ] || {
  echo "This script must run under Linux or WSL2." >&2
  exit 1
}
[ "$(id -u)" -eq 0 ] || {
  echo "Run with sudo: debootstrap and chroot require root." >&2
  exit 1
}

for tool in debootstrap mkfs.ext4 truncate sha256sum chroot e2fsck node realpath; do require "$tool"; done
if [ "$(uname -m)" != "x86_64" ]; then
  require qemu-i386
  echo "Warning: non-x86_64 host, i386 debootstrap requires binfmt/qemu-user." >&2
fi

if [ "$BUILD_DIR" = / ] || { [ -e "$BUILD_DIR" ] && [ ! -d "$BUILD_DIR" ]; }; then
  echo "Refusing unsafe build directory: $BUILD_DIR" >&2
  exit 1
fi
if [ "$BUILD_DIR" != "$DEFAULT_BUILD_DIR" ] && [ -d "$BUILD_DIR" ] &&
   [ ! -f "$BUILD_DIR/.lumiboot-build" ] && [ -n "$(ls -A "$BUILD_DIR")" ]; then
  echo "Refusing to erase an existing custom directory without .lumiboot-build: $BUILD_DIR" >&2
  exit 1
fi
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
: > "$BUILD_DIR/.lumiboot-build"

echo "== 1. debootstrap $RELEASE/$ARCH (minbase) -- flavor=$FLAVOR =="
debootstrap --arch="$ARCH" --variant=minbase "$RELEASE" "$ROOTFS" "$DEBIAN_MIRROR"

echo "== 2. Base rootfs configuration =="
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

# Written before and after the install: the console-setup postinst can regenerate
# this file from debconf.
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

echo "== 3. chroot mounts =="
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

echo "== 4. Package installation (common base + flavor $FLAVOR) =="
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

echo "== 4b. fr keyboard + fr_FR/en_US locales =="
# Firm rewrite: the console-setup postinst may have regenerated it.
write_keyboard_config "$ROOTFS"
sed -i 's/^# *\(fr_FR.UTF-8 UTF-8\)/\1/' "$ROOTFS/etc/locale.gen"
sed -i 's/^# *\(en_US.UTF-8 UTF-8\)/\1/' "$ROOTFS/etc/locale.gen"
grep -qxF 'fr_FR.UTF-8 UTF-8' "$ROOTFS/etc/locale.gen" || echo 'fr_FR.UTF-8 UTF-8' >> "$ROOTFS/etc/locale.gen"
grep -qxF 'en_US.UTF-8 UTF-8' "$ROOTFS/etc/locale.gen" || echo 'en_US.UTF-8 UTF-8' >> "$ROOTFS/etc/locale.gen"
chroot "$ROOTFS" locale-gen
printf 'LANG=fr_FR.UTF-8\n' > "$ROOTFS/etc/default/locale"

echo "== 4c. vim: expose /usr/bin/vim (vim-tiny only provides vim.tiny) =="
if [ -x "$ROOTFS/usr/bin/vim.tiny" ] && [ ! -e "$ROOTFS/usr/bin/vim" ]; then
  chroot "$ROOTFS" update-alternatives --install /usr/bin/vim vim /usr/bin/vim.tiny 10
fi

if [ "$GRAPHICAL" = "true" ]; then
  echo "== 4d. Xorg graphical stack / session manager =="
  # Two ServerLayouts, fbdev first and modesetting as fallback, selected by
  # lumiboot-startx; vesa cannot attach once a KMS driver is bound.
  install -d -m 0755 "$ROOTFS/etc/X11/xorg.conf.d"
  install -D -m 0644 "$HERE/guest/xorg.conf.d/20-lumiboot-fbdev.conf" \
    "$ROOTFS/etc/X11/xorg.conf.d/20-lumiboot-fbdev.conf"

  # Xorg needs root rights for /dev/fb0, while the session stays unprivileged.
  cat > "$ROOTFS/etc/X11/Xwrapper.config" <<'EOF'
# Xorg wrapper for v86: root rights are needed to drive /dev/fb0, and the
# lumiboot user must be allowed to start the server.
allowed_users=anybody
needs_root_rights=yes
EOF
  chmod 0644 "$ROOTFS/etc/X11/Xwrapper.config"

  # Belt and braces: keep the setuid bit of Xorg.wrap.
  if [ -e "$ROOTFS/usr/lib/xorg/Xorg.wrap" ]; then
    chmod u+s "$ROOTFS/usr/lib/xorg/Xorg.wrap"
  fi

  # Session launcher: fbdev then modesetting; the flavor's .xinitrc picks the session.
  install -D -m 0755 "$HERE/guest/lumiboot-startx" \
    "$ROOTFS/usr/local/bin/lumiboot-startx"
fi

echo "== 5. initramfs: emulated storage/FS drivers =="
cat > "$ROOTFS/etc/initramfs-tools/modules" <<EOF
ext4
ata_piix
ata_generic
sd_mod
EOF
sed -i 's/^MODULES=.*/MODULES=most/' "$ROOTFS/etc/initramfs-tools/initramfs.conf" 2>/dev/null || true

echo "== 6. Unprivileged user + serial console =="
chroot "$ROOTFS" bash -e -c '
  if ! id lumiboot >/dev/null 2>&1; then
    useradd --create-home --shell /bin/bash lumiboot
  fi
  passwd -d lumiboot >/dev/null
  # /dev/fb0 access for the X fbdev driver, through the video group.
  if getent group video >/dev/null 2>&1; then
    usermod -aG video lumiboot
  fi
'

install -D -m 0644 "$HERE/guest/serial-getty-autologin.conf" \
  "$ROOTFS/etc/systemd/system/serial-getty@ttyS0.service.d/autologin.conf"
install -D -m 0644 "$HERE/guest/getty-autologin.conf" \
  "$ROOTFS/etc/systemd/system/getty@tty1.service.d/autologin.conf"
# The minimal flavor blacklists bochs to stay in text mode; the graphical flavors
# need bochs-drm, the only /dev/fb0 provider under v86.
if [ "$FLAVOR" = "minimal" ]; then
  install -D -m 0644 "$HERE/guest/no-drm.conf" \
    "$ROOTFS/etc/modprobe.d/lumiboot-no-drm.conf"
fi

# GUEST_READY marker: same unit for both flavors, different image reference.
if [ -n "$READY_SERVICE_SRC" ]; then
  install -D -m 0644 "$HERE/guest/$READY_SERVICE_SRC" \
    "$ROOTFS/etc/systemd/system/lumiboot-ready.service"
else
  install -D -m 0644 "$HERE/guest/lumiboot-ready.service" \
    "$ROOTFS/etc/systemd/system/lumiboot-ready.service"
fi

# tty1 autologin starts startx, then the flavor's .xinitrc runs the session;
# DESKTOP_READY is emitted only after a real check of X and of the session.
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

# Also add the multi-user.target.wants link expected by the acceptance check.
ln -sf /lib/systemd/system/keyboard-setup.service \
  "$ROOTFS/etc/systemd/system/multi-user.target.wants/keyboard-setup.service"

echo "== 6b. NOPASSWD sudo for lumiboot =="
printf "%s\n" "lumiboot ALL=(ALL) NOPASSWD:ALL" > "$ROOTFS/etc/sudoers.d/90-lumiboot"
chmod 0440 "$ROOTFS/etc/sudoers.d/90-lumiboot"
chroot "$ROOTFS" bash -e -c '
  if command -v visudo >/dev/null 2>&1; then
    visudo -cf /etc/sudoers.d/90-lumiboot
  fi
'

echo "== 6c. Guest network: DHCP (systemd-networkd) + DNS (systemd-resolved) =="
# minbase configures no network: networkd brings DHCPv4 up and resolved the DNS.
install -d -m 0755 "$ROOTFS/etc/systemd/network"
cat > "$ROOTFS/etc/systemd/network/20-lumiboot.network" <<'EOF'
# Wired virtio-net interface; `eth*` is a fallback for older naming.
[Match]
Name=en* eth*

[Network]
DHCP=ipv4

# The v86 DHCP server omits option 51, which makes the systemd client reject the
# lease; a fallback lifetime lets it accept.
[DHCPv4]
FallbackLeaseLifetimeSec=infinity
EOF

chroot "$ROOTFS" bash -e -c '
  systemctl enable systemd-networkd.service
  systemctl enable systemd-resolved.service
'

echo "== 7. initramfs regeneration =="
chroot "$ROOTFS" update-initramfs -u -k all

echo "== 8. Kernel + initrd extraction (same version) =="
# Default `dpkg-query -W` format is "Package<TAB>Version": no `$` to escape.
chroot "$ROOTFS" env PACKAGES="$PACKAGES" bash -c 'dpkg-query -W $PACKAGES' \
  > "$BUILD_DIR/packages.tsv" 2>/dev/null || true

echo "== 8b. In-rootfs verification (tools, keyboard, locale, graphics) =="
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
  echo "--- generated locales"; locale -a | grep -iE "fr_FR|en_US" || echo "(none)"
  echo "--- os-release"; grep PRETTY_NAME /etc/os-release
  echo "--- guest network"
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
    echo "--- graphical stack"
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
    echo "--- X drivers fbdev / modesetting ---"
    test -e /usr/lib/xorg/modules/drivers/fbdev_drv.so && echo "fbdev_drv.so: present" || echo "fbdev_drv.so: MISSING" >&2
    test -e /usr/lib/xorg/modules/drivers/modesetting_drv.so && echo "modesetting_drv.so: present" || echo "modesetting_drv.so: MISSING (provided by xserver-xorg-core)" >&2
    echo "--- Xorg setuid wrapper (kernel framebuffer /dev/fb0) ---"
    ls -l /usr/lib/xorg/Xorg.wrap /etc/X11/Xwrapper.config 2>/dev/null || true
    cat /etc/X11/Xwrapper.config 2>/dev/null || echo "MISS Xwrapper.config"
    if [ -u /usr/lib/xorg/Xorg.wrap ]; then
      echo "Xorg.wrap setuid: OK"
    else
      echo "Xorg.wrap setuid: MISSING (Xorg will not be able to drive the framebuffer)" >&2
      exit 1
    fi
    echo "--- lumiboot groups (video required for /dev/fb0) ---"
    id lumiboot
  fi
'

KERNEL_VERSION="$(ls "$ROOTFS/boot" | sed -n 's/^vmlinuz-\(.*\)$/\1/p' | head -n1)"
[ -n "${KERNEL_VERSION:-}" ] || { echo "Kernel not found in $ROOTFS/boot." >&2; exit 1; }
cp "$ROOTFS/boot/vmlinuz-$KERNEL_VERSION" "$BUILD_DIR/vmlinuz-686"
cp "$ROOTFS/boot/initrd.img-$KERNEL_VERSION" "$BUILD_DIR/initrd.img"

cleanup_mounts
trap - EXIT

echo "== 8c. resolv.conf: systemd-resolved resolv.conf (removes the host WSL file) =="
# debootstrap copied the host resolv.conf; replace it last by a symlink to
# systemd-resolved's upstream file, which exposes the guest DHCP DNS.
rm -f "$ROOTFS/etc/resolv.conf"
ln -sf /run/systemd/resolve/resolv.conf "$ROOTFS/etc/resolv.conf"
ls -l "$ROOTFS/etc/resolv.conf"

echo "== 9. Raw ext4 disk image ($DISK_SIZE) =="
truncate -s "$DISK_SIZE" "$BUILD_DIR/rootfs.img"
mkfs.ext4 -F -L lumiboot -d "$ROOTFS" "$BUILD_DIR/rootfs.img"

# mkfs.ext4 -d can leave directory blocks without room for the checksum tail,
# which floods the guest kernel log; e2fsck -fyD rebuilds them.
e2fsck -fyD "$BUILD_DIR/rootfs.img"

# Final read-only check: any remaining inconsistency fails the build.
e2fsck -fn "$BUILD_DIR/rootfs.img"

# mkfs.ext4 -d must preserve the setuid bit of Xorg.wrap, checked inside the
# produced image.
if [ "$GRAPHICAL" = "true" ]; then
  echo "== 9b. setuid bit check inside rootfs.img (debugfs) =="
  if debugfs -R 'stat /usr/lib/xorg/Xorg.wrap' "$BUILD_DIR/rootfs.img" 2>/dev/null | grep -qE 'Mode: *0?[4-7][0-7]{3}'; then
    echo "Xorg.wrap in rootfs.img: setuid present"
  else
    debugfs -R 'stat /usr/lib/xorg/Xorg.wrap' "$BUILD_DIR/rootfs.img" 2>&1 | sed -n '1,6p' || true
    echo "Xorg.wrap in rootfs.img: setuid ABSENT (X would fail under v86)." >&2
    exit 1
  fi
fi

echo "== 10. Manifest + provenance (real sizes + SHA) =="
# Only the graphical flavors publish a kernel cmdline.
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
  echo "snapshot: ${SNAPSHOT:-none (live mirror)}"
  echo "debootstrap: $(debootstrap --version 2>/dev/null | head -n1 || echo unknown)"
  echo "built-utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "note: the real SHA-256 of the artifacts are in manifest.json."
  echo "note: built locally by this script on a Linux host with debootstrap; not produced by CI, not signed by Debian."
} > "$BUILD_DIR/provenance.txt"
cat "$BUILD_DIR/provenance.txt"

cat <<EOF

Build complete (flavor=$FLAVOR, ref=$REF).

To publish into the application:
  cp "$BUILD_DIR/rootfs.img"           "$HERE/../../apps/web/public/images/$REF/"
  cp "$BUILD_DIR/vmlinuz-686"          "$HERE/../../apps/web/public/images/$REF/"
  cp "$BUILD_DIR/initrd.img"           "$HERE/../../apps/web/public/images/$REF/"
  cp "$BUILD_DIR/manifest.json"        "$HERE/../../apps/web/public/images/$REF/"

Then verify the HTTP Range requests, then the real smoke test.
For the minimal flavor: images/debian-12-i386/tests/boot-smoke-test.md
For the desktop flavor: images/debian-12-i386/tests/desktop-smoke-test.md
For the xfce flavor   : images/debian-12-i386/tests/xfce-smoke-test.md

Only switch a system to availability:'ready' (and v86.integrated to true) AFTER
a boot that is actually proven (see images/debian-12-i386/README.md).
EOF
