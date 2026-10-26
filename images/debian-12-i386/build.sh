#!/usr/bin/env bash
#
# Reproducible build of a Debian 12 Bookworm i386 image for v86.
#
#   sudo ./images/debian-12-i386/build.sh              # "minimal" flavor (console, default)
#   sudo FLAVOR=desktop ./images/debian-12-i386/build.sh   # "desktop" flavor (Xorg + Openbox)
#   sudo FLAVOR=xfce ./images/debian-12-i386/build.sh      # "xfce" flavor (Xorg + XFCE)
#   sudo ./images/debian-12-i386/build.sh desktop          # equivalent (flavor as first argument)
#
# Run under Linux or WSL2, never on native Windows nor in a pipeline without
# debootstrap. Never commit the produced binaries.
#
# WARNING: THIS SCRIPT HAS NOT BEEN EXECUTED in this repository's development
#     environment (no debootstrap, no WSL, no Docker: no image can be built nor
#     booted here). It must be tested on a suitable Linux/WSL2 machine BEFORE
#     any publication. No real boot is proven at this stage.
#
# Three flavors share the SAME base below (no copy-paste):
#
#   * minimal  (default) -- validated E2E baseline: serial console + VGA, marker
#              LUMIBOOT_GUEST_READY:debian-12-i386. Behavior/compatibility
#              UNCHANGED compared to the previous version of the script.
#   * desktop  -- minimal base + Xorg/Openbox graphical stack (see 4d), graphical
#              session on the VGA canvas (autologin of the unprivileged account
#              "lumiboot", never root). Emits
#              LUMIBOOT_GUEST_READY:debian-12-i386-desktop (OS operational)
#              THEN, only after the X server and the session have actually
#              started, LUMIBOOT_DESKTOP_READY:debian-12-i386-desktop.
#   * xfce     -- minimal base + Xorg/XFCE graphical stack (full desktop
#              environment). Same markers, prefixed
#              LUMIBOOT_GUEST_READY:debian-12-i386-xfce then
#              LUMIBOOT_DESKTOP_READY:debian-12-i386-xfce. Its X configuration
#              (fbdev/modesetting) is SHARED with the desktop flavor. WARNING:
#              XFCE has NOT been built nor tested yet: no real boot proven.
#
#     The markers are emitted by the GUEST system through systemd (see guest/),
#     never by JavaScript, and written to the serial console (ttyS0).
#
# Output in images/debian-12-i386/build[-desktop|-xfce]/ :
#   rootfs.img      raw ext4 disk (Debian root)
#   vmlinuz-686     kernel (bzimage) of the same version as the initrd
#   initrd.img      matching initramfs
#   manifest.json   real sizes + SHA-256 (strict @lumiboot/vm-assets schema)
#   packages.tsv    actually installed versions (traceability)
#   provenance.txt  mirror, release, optional snapshot, date, debootstrap version
#
# PINNING: the Debian release is pinned (bookworm). For a strictly reproducible
# build, point to a dated snapshot:
#   sudo SNAPSHOT=20240101T000000Z ./images/debian-12-i386/build.sh
# (packages then come from snapshot.debian.org, cf. step 2).
set -euo pipefail

# --- Flavor parameters -------------------------------------------------------
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
    # XFCE is much larger than the base: disk widened to 4 GiB
    # (overridable through DISK_SIZE=... as before).
    DISK_SIZE_DEFAULT="4G"
    ;;
  *)
    echo "Unknown flavor: \"$FLAVOR\" (expected: minimal | desktop | xfce)." >&2
    exit 1
    ;;
esac

# Graphical flavor (Xorg + session manager): desktop (Openbox) or xfce.
# Drives the sharing of most steps (graphical stack, session, marker).
GRAPHICAL=""
if [ "$FLAVOR" = "desktop" ] || [ "$FLAVOR" = "xfce" ]; then
  GRAPHICAL="true"
fi

RELEASE="bookworm"
ARCH="i386"
DEBIAN_MIRROR="${DEBIAN_MIRROR:-https://deb.debian.org/debian}"
SECURITY_MIRROR="${SECURITY_MIRROR:-http://security.debian.org/debian-security}"
# Optional dated snapshot (snapshot.debian.org format: 20240101T000000Z).
SNAPSHOT="${SNAPSHOT:-}"
DISK_SIZE="${DISK_SIZE:-$DISK_SIZE_DEFAULT}"

# Kernel cmdline of the graphical flavors (desktop and xfce). Identical to the
# base (V86Provider.DEFAULT_BOOT_CMDLINE) PLUS "vga=0x318" (1024x768x24): under
# v86 there is no DRM, so the kernel VBE framebuffer console is forced to obtain
# /dev/fb0, required by the Xorg "fbdev" fallback. The minimal flavor does NOT
# emit boot.cmdline: it keeps the text VGA console and the provider's
# DEFAULT_BOOT_CMDLINE (behavior unchanged).
DESKTOP_CMDLINE="console=tty0 console=ttyS0,115200 root=/dev/sda rw vga=0x318"

if [ -n "$SNAPSHOT" ]; then
  DEBIAN_MIRROR="https://snapshot.debian.org/archive/debian/$SNAPSHOT"
  SECURITY_MIRROR="https://snapshot.debian.org/archive/debian-security/$SNAPSHOT"
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The build directory can be moved outside the repository (e.g. onto a native
# ext4 filesystem under WSL) through LUMIBOOT_BUILD_DIR. Required because
# debootstrap and chroot fail on 9p/DrvFs filesystems (/mnt/c): extracting some
# packages (e.g. libpam-runtime) makes tar fail. By default, behavior is
# unchanged (build/, build-desktop/ or build-xfce/ inside the repository).
BUILD_DIR="${LUMIBOOT_BUILD_DIR:-$HERE/build$BUILD_SUFFIX}"
ROOTFS="$BUILD_DIR/rootfs"

# Packages of the common base (identical for ALL flavors: the console baseline
# stays strictly the same).
BASE_PACKAGES="linux-image-686 initramfs-tools systemd-sysv systemd-resolved udev kmod \
bash coreutils util-linux mount login passwd sudo \
curl wget ca-certificates gnupg openssl \
tar gzip bzip2 xz-utils zstd zip unzip \
less nano vim-tiny file tree rsync git \
bash-completion gawk sed grep findutils procps psmisc man-db manpages htop \
iproute2 iputils-ping dnsutils \
python3 perl \
console-setup kbd locales"

# Graphical packages SHARED by the desktop (Openbox) and xfce flavors: minimal
# Xorg stack (server, drivers, input, xinit, utilities), fonts and the session
# D-Bus bus. Deliberately WITHOUT GNOME/KDE nor Wayland.
#
# Video driver: under v86 the kernel attaches a `bochs-drm` KMS driver
# (framebuffer /dev/fb0). A VBE driver (`vesa`) then refuses to attach and X
# fails with "no screens found". `fbdev` (kernel framebuffer) is therefore used
# as primary and `modesetting` (KMS, provided by `xserver-xorg-core`) as
# fallback -- see guest/xorg.conf.d/20-lumiboot-fbdev.conf (SHARED file).
#
# `xserver-xorg-legacy` is kept: it provides the setuid wrapper
# `/usr/lib/xorg/Xorg.wrap` (+ `/etc/X11/Xwrapper.config`), required because
# Xorg is started by the unprivileged "lumiboot" account with
# `needs_root_rights=yes`.
X_PACKAGES="xserver-xorg-core xserver-xorg-legacy xserver-xorg-video-vesa xserver-xorg-video-fbdev \
xserver-xorg-input-libinput xinit x11-xserver-utils x11-utils x11-xkb-utils xauth \
fonts-dejavu-core dbus-x11"

# Desktop-flavor specific addition: Openbox + xterm (minimal desktop session).
DESKTOP_PACKAGES="$X_PACKAGES xterm openbox"

# XFCE-flavor specific addition: full XFCE desktop environment. No display
# manager (lightdm/GDM): direct start through startx+~/.xinitrc.
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

for tool in debootstrap mkfs.ext4 truncate sha256sum chroot e2fsck node; do require "$tool"; done
if [ "$(uname -m)" != "x86_64" ]; then
  require qemu-i386
  echo "Warning: non-x86_64 host, i386 debootstrap requires binfmt/qemu-user." >&2
fi

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

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

# French AZERTY keyboard: written BEFORE the install so that console-setup /
# keyboard-configuration pick it up, and rewritten AFTERWARDS (their postinst
# can regenerate this file from debconf) to guarantee XKBLAYOUT="fr".
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

# debconf preseed answers: avoids any keyboard/locale prompt in noninteractive mode.
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
# Firm rewrite after install (the console-setup postinst may have regenerated it).
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

# -- 4d. Graphical stack (graphical flavors: desktop and xfce) ----------------
if [ "$GRAPHICAL" = "true" ]; then
  echo "== 4d. Xorg graphical stack / session manager =="
  # Video driver: the kernel attaches the "bochs-drm" KMS driver (framebuffer
  # /dev/fb0). TWO ServerLayouts are defined (fbdev primary, modesetting as
  # fallback), selected by /usr/local/bin/lumiboot-startx. "vesa" is no longer
  # used (it refuses to attach when a KMS driver is bound -> "no screens found").
  # This configuration is SHARED by desktop and xfce (a single source file).
  install -d -m 0755 "$ROOTFS/etc/X11/xorg.conf.d"
  install -D -m 0644 "$HERE/guest/xorg.conf.d/20-lumiboot-fbdev.conf" \
    "$ROOTFS/etc/X11/xorg.conf.d/20-lumiboot-fbdev.conf"

  # Xwrapper.config: allows Xorg to be started by the UNPRIVILEGED "lumiboot"
  # account with root rights (needs_root_rights=yes). The setuid Xorg.wrap
  # wrapper comes from xserver-xorg-legacy. The SESSION (Openbox or XFCE) itself
  # stays unprivileged.
  cat > "$ROOTFS/etc/X11/Xwrapper.config" <<'EOF'
# Xorg wrapper configuration (xserver-xorg-legacy) for v86.
# The X server needs root rights (needs_root_rights=yes) to drive the kernel
# framebuffer /dev/fb0, while the start by the "lumiboot" user must be allowed
# (allowed_users). Without the setuid bit of Xorg.wrap, Xorg fails with
# "no screens found".
allowed_users=anybody
needs_root_rights=yes
EOF
  chmod 0644 "$ROOTFS/etc/X11/Xwrapper.config"

  # Belt and braces: the package installs Xorg.wrap as 6755 (setuid+setgid).
  # The setuid bit is (re)applied so we never ship an image where Xorg cannot
  # drive the kernel framebuffer -- a possible cause of "no screens found".
  if [ -e "$ROOTFS/usr/lib/xorg/Xorg.wrap" ]; then
    chmod u+s "$ROOTFS/usr/lib/xorg/Xorg.wrap"
  fi

  # Session launcher: tries "fbdev" then "modesetting" as a fallback (shared
  # desktop/xfce; the session choice is made by the flavor's ~/.xinitrc).
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
  # Read/write access to the kernel framebuffer /dev/fb0 ("video" group),
  # required by the X "fbdev" driver of the desktop flavor (useless on console).
  if getent group video >/dev/null 2>&1; then
    usermod -aG video lumiboot
  fi
'

install -D -m 0644 "$HERE/guest/serial-getty-autologin.conf" \
  "$ROOTFS/etc/systemd/system/serial-getty@ttyS0.service.d/autologin.conf"
install -D -m 0644 "$HERE/guest/getty-autologin.conf" \
  "$ROOTFS/etc/systemd/system/getty@tty1.service.d/autologin.conf"
# Text VGA console: the minimal flavor blacklists the `bochs` DRM driver to
# stay in text mode (`vga-console` checks). The graphical flavors (desktop,
# xfce) want a REAL framebuffer /dev/fb0 instead (Xorg `fbdev` fallback): under
# v86 the only framebuffer provider is `bochs-drm` (the Debian 6.1 kernel no
# longer honors `vga=` at boot). `bochs` is therefore NOT blacklisted in
# desktop/xfce.
if [ "$FLAVOR" = "minimal" ]; then
  install -D -m 0644 "$HERE/guest/no-drm.conf" \
    "$ROOTFS/etc/modprobe.d/lumiboot-no-drm.conf"
fi

# GUEST_READY marker: same "lumiboot-ready.service" unit for both flavors,
# adapted content (different image reference).
if [ -n "$READY_SERVICE_SRC" ]; then
  install -D -m 0644 "$HERE/guest/$READY_SERVICE_SRC" \
    "$ROOTFS/etc/systemd/system/lumiboot-ready.service"
else
  install -D -m 0644 "$HERE/guest/lumiboot-ready.service" \
    "$ROOTFS/etc/systemd/system/lumiboot-ready.service"
fi

# Graphical session (desktop/xfce flavors): tty1 autologin -> ~/.bash_profile
# runs startx -> ~/.xinitrc starts the session (Openbox or XFCE). The
# DESKTOP_READY marker is only emitted after a real check of the X server and of
# the session. The overlays come from the `guest/<flavor>/` folder.
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

# Debian enables keyboard-setup.service through sysinit.target.wants (WantedBy
# =sysinit.target); the multi-user.target.wants link expected by the acceptance
# check is also added. No double effect: oneshot unit.
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
# The minbase image configures NO network at all: the v86 virtio NIC (enp0s10)
# is detected but stays DOWN, with no DHCP lease and no resolver. networkd
# (DHCPv4 on wired interfaces) and resolved (DNS) are therefore enabled.
# systemd-networkd is provided by the `systemd` package; resolved by
# `systemd-resolved` (installed in step 4).
install -d -m 0755 "$ROOTFS/etc/systemd/network"
cat > "$ROOTFS/etc/systemd/network/20-lumiboot.network" <<'EOF'
# Wired interface emulated by v86 (virtio-net, enp0s10). `Name=en*` covers
# predictable names (enp0s10, ens3...); `eth*` is a fallback for eth0.
[Match]
Name=en* eth*

[Network]
DHCP=ipv4

# The v86 virtual DHCP server ("fetch" backend) returns a DHCPOFFER WITHOUT
# option 51 (lease lifetime). The systemd DHCPv4 client (>= v250) then rejects
# the lease ("received lease lacks address, server address or lease lifetime")
# and never configures the interface. Debian bookworm ships a systemd 252 that
# can install a fallback lease: it is explicitly allowed here.
# (systemd only accepts "forever" or "infinity" here.)
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
# Default `dpkg-query -W` format = "Package<TAB>Version": no -f, hence no `$`
# to escape across the shell/chroot layers.
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
# debootstrap/apt copied the HOST's /etc/resolv.conf ("generated by WSL,
# nameserver 10.255.255.254"): stale and useless inside the guest. It is
# replaced LAST (after every install that needs the host's DNS) by a symlink to
# systemd-resolved's "upstream" resolv.conf, recreated at every boot. The
# upstream file is targeted (not the 127.0.0.53 stub) so that
# `cat /etc/resolv.conf` directly exposes the DNS provided by the v86 virtual
# DHCP (e.g. 192.168.86.1).
rm -f "$ROOTFS/etc/resolv.conf"
ln -sf /run/systemd/resolve/resolv.conf "$ROOTFS/etc/resolv.conf"
ls -l "$ROOTFS/etc/resolv.conf"

echo "== 9. Raw ext4 disk image ($DISK_SIZE) =="
truncate -s "$DISK_SIZE" "$BUILD_DIR/rootfs.img"
mkfs.ext4 -F -L lumiboot -d "$ROOTFS" "$BUILD_DIR/rootfs.img"

# `mkfs.ext4 -d` (metadata_csum enabled by default) can produce directory
# blocks with no room for the checksum tail -> the guest kernel logs in a loop
# "No space for directory leaf checksum. Please run e2fsck -D." then
# "ext4_find_entry: reading directory lblock 0" on every read of the affected
# directory. `e2fsck -fyD` rebuilds the directory indexes/checksums (option -D)
# directly inside the freshly created image.
e2fsck -fyD "$BUILD_DIR/rootfs.img"

# Final READ-ONLY check: the pass above must have left a clean filesystem; any
# remaining inconsistency must fail the build.
e2fsck -fn "$BUILD_DIR/rootfs.img"

# Post-copy verification: `mkfs.ext4 -d` MUST preserve the setuid bit of
# Xorg.wrap (tree extraction/copy without losing permissions). It is checked
# directly INSIDE the produced image, not only inside the chroot.
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
# The graphical flavors (desktop, xfce) publish their own kernel cmdline (VBE
# framebuffer for the Xorg fbdev fallback); the minimal flavor does not emit it
# and keeps the provider default (text console) -- behavior unchanged.
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
  echo "note: this build was NOT executed in the development environment (no real image)."
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
a boot that is actually proven (see docs/debian-desktop.md and docs/debian-xfce.md).
EOF
