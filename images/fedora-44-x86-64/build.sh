#!/usr/bin/env bash
#
# Reproducible build of a Fedora 44 x86-64 live image for v64.
#
#   sudo ./images/fedora-44-x86-64/build.sh                 # CLI flavor
#   sudo FLAVOR=xfce ./images/fedora-44-x86-64/build.sh     # XFCE flavor
#   sudo ./images/fedora-44-x86-64/build.sh xfce            # flavor as first argument
#
# FLAVOR picks the guest, like the Debian/Ubuntu scripts:
#   cli  -> fedora-44-x86-64       minimal live console (default)
#   xfce -> fedora-44-x86-64-xfce  Xorg + XFCE session on tty1
#
# Requires Linux or WSL2, root, a dnf repository for FEDORA_RELEASEVER, and the
# tools dnf, rpm, dracut, mksquashfs (squashfs-tools), mke2fs (e2fsprogs),
# xorriso, cpio, xz, node and grub-mkrescue (Debian/Ubuntu: grub-common,
# grub-pc-bin and mtools). The GPG key of the release must be installed on
# the host (/etc/pki/rpm-gpg/RPM-GPG-KEY-fedora-<releasever>-primary): packages
# are always signature-checked, never installed from an unauthenticated mirror.
# FEDORA_RELEASEVER, FEDORA_MIRROR, ISO_LABEL, DISK_MIB and LUMIBOOT_BUILD_DIR
# override the release, the mirror, the ISO label, the ext4 size and the build
# directory.
# Writes vmlinuz, initrd.img, <ref>.iso, manifest.json, packages.tsv and
# provenance.txt into build/ (cli) or build-xfce/ (xfce). The ISO carries the
# kernel, the initramfs and a GRUB El-Torito boot record: the guest boots from
# the disc itself.
set -euo pipefail

FLAVOR="${1:-${FLAVOR:-cli}}"
case "$FLAVOR" in
  cli)
    REF="fedora-44-x86-64"
    # A console guest needs no desktop memory.
    MEMORY_MIB="1024"
    VGA_MIB="32"
    # Size of the ext4 filesystem stored inside the live squashfs. The empty
    # space compresses to almost nothing, so the default stays generous.
    DISK_MIB_DEFAULT="2048"
    BUILD_SUFFIX=""
    ISO_LABEL_DEFAULT="LUMIBOOT-FEDORA"
    GRAPHICAL=""
    ;;
  xfce)
    REF="fedora-44-x86-64-xfce"
    # Xorg, XFCE and Mesa need headroom; v64 rounds the size to whole MiB.
    MEMORY_MIB="2048"
    VGA_MIB="32"
    # XFCE plus the DRM kernel modules is much larger than the console.
    DISK_MIB_DEFAULT="4096"
    BUILD_SUFFIX="-xfce"
    # A distinct CDLABEL is mandatory: `root=live:CDLABEL=...` is the only way
    # the initramfs finds its medium, so the two ISOs must never share a label.
    ISO_LABEL_DEFAULT="LUMIBOOT-FEDORA-XFCE"
    GRAPHICAL="true"
    ;;
  *)
    echo "Unknown flavor: \"$FLAVOR\" (expected: cli | xfce)." >&2
    exit 1
    ;;
esac

ARCH="x86_64"
FEDORA_RELEASEVER="${FEDORA_RELEASEVER:-44}"
FEDORA_MIRROR="${FEDORA_MIRROR:-https://download.fedoraproject.org/pub/fedora/linux}"
ISO_LABEL="${ISO_LABEL:-$ISO_LABEL_DEFAULT}"
DISK_MIB="${DISK_MIB:-$DISK_MIB_DEFAULT}"

# dracut finds the live root through the ISO label, hence CDLABEL. `rd.live.image`
# asks dmsquash-live for the live image layout (LiveOS/squashfs.img) and
# `selinux=0` avoids an overlay without labels; `loglevel=4` keeps the serial
# log readable under emulation.
LIVE_CMDLINE="console=tty0 console=ttyS0,115200 root=live:CDLABEL=$ISO_LABEL rd.live.image selinux=0 loglevel=4"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The build directory can live on a native ext4 filesystem outside the
# repository: chroot and mke2fs -d fail on 9p/DrvFs mounts.
DEFAULT_BUILD_DIR="$(realpath -m -- "$HERE/build$BUILD_SUFFIX")"
BUILD_DIR="$(realpath -m -- "${LUMIBOOT_BUILD_DIR:-$DEFAULT_BUILD_DIR}")"
ROOTFS="$BUILD_DIR/rootfs"
# Contents of LiveOS/squashfs.img, then of the ISO.
SQUASH_ROOT="$BUILD_DIR/squashfs"
ISO_ROOT="$BUILD_DIR/iso"
ARTIFACT_ISO="$BUILD_DIR/$REF.iso"
REPO_DIR="$BUILD_DIR/dnf-repos"

# Minimal live guest, grouped by purpose. Nothing else is installed: no
# userland in the rootfs is unused by the boot path, the console or the marker.
PACKAGES=(
  # Distribution identity (/etc/os-release, presets) and the base filesystem.
  fedora-release basesystem
  # init, device manager and the console getty on tty1 and ttyS0.
  systemd systemd-udev
  # Kernel, and the dracut live stack that mounts the ISO and the squashfs.
  kernel-core dracut dracut-live
  # ext4 for the live rootfs image.
  e2fsprogs
  # Shell and the tools used by the guest units and by the smoke test.
  bash coreutils util-linux shadow-utils passwd sudo
  # AZERTY console keymap, and the compression dracut is asked to use.
  kbd procps-ng grep sed tar gzip xz
)

# Graphical stack of the `xfce` flavor only; the console flavor installs none
# of it. Fedora 41+ retired the `xorg-x11-drv-vesa` and `xorg-x11-drv-fbdev`
# drivers (dead upstream packages), so the only X video path here is
# `modesetting` on the bochs-drm KMS device, which lives in kernel-modules.
# `xorg-x11-utils` no longer exists either: its tools are individual packages.
XFCE_PACKAGES=(
  # DRM/input kernel modules (bochs-drm, evdev): kernel-core carries none of them.
  kernel-modules
  # Xorg server (ships the modesetting driver) and startx.
  xorg-x11-server-Xorg xorg-x11-xinit
  # libinput input driver, and xkbcomp which Xorg runs to build the keymap.
  xorg-x11-drv-libinput xkbcomp
  # xdpyinfo (readiness probe of the guest unit), xrandr and xprop.
  xdpyinfo xrandr xprop
  # XFCE: session, window manager, panel, desktop, settings daemon, file manager.
  xfce4-session xfwm4 xfce4-panel xfdesktop xfce4-settings xfconf thunar
  # Terminal, application finder, fonts and Mesa's software GL drivers.
  xfce4-terminal xfce4-appfinder dejavu-sans-fonts mesa-dri-drivers
  # System bus and dbus-launch, which the XFCE session script starts.
  dbus-daemon dbus-x11
)
if [ "$GRAPHICAL" = "true" ]; then
  PACKAGES+=("${XFCE_PACKAGES[@]}")
fi

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
[ "$(uname -m)" = "x86_64" ] || {
  echo "This script must run on an x86_64 host: the guest is native x86-64." >&2
  exit 1
}
[ "$(id -u)" -eq 0 ] || {
  echo "Run with sudo: mke2fs, chroot and mksquashfs require root." >&2
  exit 1
}

for tool in dnf rpm dracut mksquashfs mke2fs xorriso grub-mkrescue mountpoint truncate chroot node realpath; do
  require "$tool"
done

# gpgcheck stays on for every package: the release key on the host is the only
# accepted signer, so a mirror can never inject an unsigned package.
GPG_KEY="/etc/pki/rpm-gpg/RPM-GPG-KEY-fedora-$FEDORA_RELEASEVER-primary"
[ -f "$GPG_KEY" ] || {
  echo "Missing Fedora $FEDORA_RELEASEVER GPG key: $GPG_KEY" >&2
  echo "Install fedora-gpg-keys $FEDORA_RELEASEVER, or point FEDORA_MIRROR at a signed mirror." >&2
  exit 1
}

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

echo "== 1. Explicit Fedora repositories (releasever=$FEDORA_RELEASEVER, x86_64) =="
# Written instead of inherited from the host, so FEDORA_MIRROR really decides the
# content and the build never depends on the host's repository files.
mkdir -p "$REPO_DIR"
cat > "$REPO_DIR/lumiboot-fedora.repo" <<EOF
[fedora]
name=Fedora $FEDORA_RELEASEVER - x86_64
baseurl=$FEDORA_MIRROR/releases/$FEDORA_RELEASEVER/Everything/x86_64/os/
enabled=1
gpgcheck=1
repo_gpgcheck=0
gpgkey=file://$GPG_KEY

[updates]
name=Fedora $FEDORA_RELEASEVER updates - x86_64
baseurl=$FEDORA_MIRROR/updates/$FEDORA_RELEASEVER/Everything/x86_64/
enabled=1
gpgcheck=1
repo_gpgcheck=0
gpgkey=file://$GPG_KEY
EOF

DNF_OPTS=(
  --installroot="$ROOTFS"
  --releasever="$FEDORA_RELEASEVER"
  --setopt=reposdir="$REPO_DIR"
  --setopt=install_weak_deps=False
  --setopt=tsflags=nodocs
)

echo "== 2. Package installation (flavor=$FLAVOR, ref=$REF) =="
dnf -y "${DNF_OPTS[@]}" install "${PACKAGES[@]}"

# Fedora 42+ keeps the real kernel in /usr/lib/modules/<kver>/vmlinuz and only
# links it into /boot when a bootloader is installed: accept both layouts.
KERNEL_VERSION="$(ls "$ROOTFS/boot" 2>/dev/null | sed -n 's/^vmlinuz-\(.*\)$/\1/p' | head -n1)"
if [ -n "${KERNEL_VERSION:-}" ]; then
  KERNEL_IMAGE="$ROOTFS/boot/vmlinuz-$KERNEL_VERSION"
else
  KERNEL_IMAGE="$(find "$ROOTFS/usr/lib/modules" -maxdepth 2 -name vmlinuz -print -quit 2>/dev/null || true)"
  [ -n "$KERNEL_IMAGE" ] && KERNEL_VERSION="$(basename "$(dirname "$KERNEL_IMAGE")")"
fi
[ -n "${KERNEL_VERSION:-}" ] && [ -n "${KERNEL_IMAGE:-}" ] || {
  echo "Kernel not found in $ROOTFS/boot or $ROOTFS/usr/lib/modules." >&2
  ls "$ROOTFS/boot" >&2 || true
  exit 1
}
echo "Guest kernel: $KERNEL_VERSION"

# dracut-live ships 90dmsquash-live up to dracut 059 and 70dmsquash-live from
# dracut 060 on (Fedora 44 ships dracut 108): accept either directory name.
DRACUT_LIVE_MODULE="$(ls -d "$ROOTFS"/usr/lib/dracut/modules.d/*dmsquash-live 2>/dev/null | head -n1)"
[ -n "${DRACUT_LIVE_MODULE:-}" ] && [ -f "$DRACUT_LIVE_MODULE/module-setup.sh" ] || {
  echo "dracut live module missing (dracut-live): the ISO could not be mounted." >&2
  exit 1
}

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

echo "== 4. Guest identity, AZERTY console and prompt =="
echo "lumiboot" > "$ROOTFS/etc/hostname"
cat > "$ROOTFS/etc/hosts" <<EOF
127.0.0.1   localhost lumiboot
::1         localhost
EOF

# systemd-vconsole-setup applies this at sysinit; the readiness unit re-applies it.
cat > "$ROOTFS/etc/vconsole.conf" <<EOF
KEYMAP=fr
EOF

# Login shells read /etc/profile, which sources profile.d: same prompt on tty1
# and on the serial console.
cat > "$ROOTFS/etc/profile.d/lumiboot.sh" <<'EOF'
# LumiBoot: stable prompt on the VGA and serial consoles.
PS1='lumiboot@lumiboot:\w\$ '
export PS1
EOF
chmod 0644 "$ROOTFS/etc/profile.d/lumiboot.sh"

echo "== 5. Unprivileged user + passwordless sudo =="
chroot "$ROOTFS" bash -e -c '
  groupadd --gid 1000 lumiboot 2>/dev/null || true
  useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash --groups wheel lumiboot
  passwd -d lumiboot >/dev/null
'
printf "%s\n" "lumiboot ALL=(ALL) NOPASSWD:ALL" > "$ROOTFS/etc/sudoers.d/90-lumiboot"
chmod 0440 "$ROOTFS/etc/sudoers.d/90-lumiboot"
chroot "$ROOTFS" visudo -cf /etc/sudoers.d/90-lumiboot

echo "== 6. Autologin on tty1 and ttyS0 + readiness marker (flavor=$FLAVOR) =="
install -D -m 0644 "$HERE/guest/getty-autologin.conf" \
  "$ROOTFS/etc/systemd/system/getty@tty1.service.d/autologin.conf"
install -D -m 0644 "$HERE/guest/serial-getty-autologin.conf" \
  "$ROOTFS/etc/systemd/system/serial-getty@ttyS0.service.d/autologin.conf"

# The marker names the image reference, so both units are templates: @REF@ is
# substituted here and neither variant can ever print the other one's marker.
if [ "$GRAPHICAL" = "true" ]; then
  # Waits for the X socket and emits LUMIBOOT_DESKTOP_READY once XFCE really runs.
  install -D -m 0755 "$HERE/guest/xfce/lumiboot-desktop-ready.sh" \
    "$ROOTFS/usr/local/bin/lumiboot-desktop-ready"
  sed -i "s/@REF@/$REF/" "$ROOTFS/usr/local/bin/lumiboot-desktop-ready"
  install -D -m 0644 "$HERE/guest/xfce/lumiboot-desktop-ready.service" \
    "$ROOTFS/etc/systemd/system/lumiboot-desktop-ready.service"
  # tty1 autologin starts the session; the serial console keeps a plain shell.
  install -D -m 0644 "$HERE/guest/xfce/bash_profile" "$ROOTFS/home/lumiboot/.bash_profile"
  chroot "$ROOTFS" chown lumiboot:lumiboot /home/lumiboot/.bash_profile
  READY_UNITS="lumiboot-desktop-ready.service"
else
  install -D -m 0644 "$HERE/guest/lumiboot-ready.service" \
    "$ROOTFS/etc/systemd/system/lumiboot-ready.service"
  sed -i "s/@REF@/$REF/" "$ROOTFS/etc/systemd/system/lumiboot-ready.service"
  READY_UNITS="lumiboot-ready.service"
fi

chroot "$ROOTFS" bash -e -c "
  systemctl enable getty@tty1.service serial-getty@ttyS0.service $READY_UNITS
  # An empty /etc/machine-id counts as a first boot: systemd-firstboot would sit
  # on the console asking questions instead of handing the shell to the visitor.
  systemctl mask systemd-firstboot.service >/dev/null
"

if [ "$GRAPHICAL" = "true" ]; then
  echo "== 6b. Xorg: modesetting on the bochs-drm framebuffer =="
  # Fedora 44 has no vesa/fbdev X driver: the bochs-drm KMS device (from
  # kernel-modules) is the only framebuffer provider under v64, hence the
  # modesetting driver. The AZERTY layout is set here, not by setxkbmap.
  install -d -m 0755 "$ROOTFS/etc/X11/xorg.conf.d"
  install -D -m 0644 "$HERE/guest/xfce/xorg.conf.d/20-lumiboot-modesetting.conf" \
    "$ROOTFS/etc/X11/xorg.conf.d/20-lumiboot-modesetting.conf"
  # The server needs root rights to open the DRM device; the session itself
  # stays unprivileged. Only the autologin user ever calls startxfce4.
  cat > "$ROOTFS/etc/X11/Xwrapper.config" <<'EOF'
# Xorg wrapper for v64: root rights are needed to drive the bochs-drm device,
# and the lumiboot user must be allowed to start the server.
allowed_users=anybody
needs_root_rights=yes
EOF
  chmod 0644 "$ROOTFS/etc/X11/Xwrapper.config"
fi

echo "== 7. initramfs: dracut live stack + CD polling =="
# --no-hostonly: the build host's storage stack (NVMe, virtio) is not the
# emulated IDE/ATAPI CD of v64, so every storage driver must be embedded.
# dmsquash-live mounts squashfs.img from the ISO; pollcdrom waits for the ATAPI
# device to answer before the mount is attempted. The graphical flavor also
# needs the DRM and input modules inside the initramfs so bochs-drm can bind
# before the switch-root.
# The output path is inside the chroot (the build directory is not), then copied.
chroot "$ROOTFS" dracut --force --no-hostonly \
  --add "dmsquash-live pollcdrom" --compress xz \
  --kver "$KERNEL_VERSION" /var/tmp/lumiboot-initrd.img
cp "$ROOTFS/var/tmp/lumiboot-initrd.img" "$BUILD_DIR/initrd.img"
rm -f "$ROOTFS/var/tmp/lumiboot-initrd.img"
cp "$KERNEL_IMAGE" "$BUILD_DIR/vmlinuz"

echo "== 8. Package inventory =="
rpm --root "$ROOTFS" -qa --qf '%{NAME}\t%{VERSION}-%{RELEASE}\n' | sort \
  > "$BUILD_DIR/packages.tsv"
wc -l < "$BUILD_DIR/packages.tsv" | xargs echo "installed packages:"

echo "== 8b. In-rootfs verification (identity, keymap, markers, graphics) =="
chroot "$ROOTFS" env FLAVOR="$FLAVOR" READY_UNITS="$READY_UNITS" bash -c '
  rc=0
  echo "--- os-release"; grep PRETTY_NAME /etc/os-release
  echo "--- console keymap"; cat /etc/vconsole.conf
  echo "--- autologin"
  ls -l /etc/systemd/system/getty@tty1.service.d/autologin.conf \
        /etc/systemd/system/serial-getty@ttyS0.service.d/autologin.conf 2>/dev/null || rc=1
  echo "--- readiness unit(s)"
  for u in $READY_UNITS; do
    if systemctl is-enabled "$u" 2>/dev/null | grep -qx enabled; then
      echo "$u: ENABLED"
    else
      echo "$u: NOT ENABLED"
      rc=1
    fi
  done
  if [ "$FLAVOR" = "xfce" ]; then
    echo "--- graphical stack"
    for b in Xorg startxfce4 xfce4-session xfwm4 xdpyinfo; do
      if command -v "$b" >/dev/null 2>&1; then
        echo "OK   $b -> $(command -v "$b")"
      else
        echo "MISS $b"
        rc=1
      fi
    done
    test -x /usr/local/bin/lumiboot-desktop-ready &&
      echo "lumiboot-desktop-ready: present" || { echo "lumiboot-desktop-ready: MISSING"; rc=1; }
    marker="$(sed -n "s/.*\(LUMIBOOT_DESKTOP_READY:[a-z0-9.-]*\).*/\1/p" \
      /usr/local/bin/lumiboot-desktop-ready | head -n1)"
    if [ -n "$marker" ]; then
      echo "desktop marker: $marker"
    else
      echo "desktop marker: MISSING"
      rc=1
    fi
    ls -l /home/lumiboot/.bash_profile /etc/X11/xorg.conf.d/20-lumiboot-modesetting.conf \
          /etc/X11/Xwrapper.config 2>/dev/null || rc=1
    echo "--- X video driver (no vesa/fbdev in Fedora 44)"
    if [ -e /usr/lib64/xorg/modules/drivers/modesetting_drv.so ] ||
       [ -e /usr/lib/xorg/modules/drivers/modesetting_drv.so ]; then
      echo "modesetting_drv.so: present"
    else
      echo "modesetting_drv.so: MISSING (shipped by xorg-x11-server-Xorg)"
      rc=1
    fi
    echo "--- bochs-drm (the only /dev/fb0 provider under v64)"
    if find /usr/lib/modules -name "bochs.ko*" -print -quit | grep -q .; then
      echo "bochs.ko: present"
    else
      echo "bochs.ko: MISSING (needs kernel-modules)"
      rc=1
    fi
  else
    marker="$(sed -n "s/.*\(LUMIBOOT_GUEST_READY:[a-z0-9.-]*\).*/\1/p" \
      /etc/systemd/system/lumiboot-ready.service | head -n1)"
    if [ -n "$marker" ]; then
      echo "guest marker: $marker"
    else
      echo "guest marker: MISSING"
      rc=1
    fi
  fi
  echo "--- result"; [ "$rc" -eq 0 ] && echo "in-rootfs checks: OK" || echo "in-rootfs checks: FAILED"
  exit "$rc"
'

# The pseudo filesystems must never end up inside the image.
cleanup_mounts
trap - EXIT

echo "== 9. ext4 root inside the live squashfs =="
ROOTFS_MIB="$(du -sm "$ROOTFS" | cut -f1)"
[ "$ROOTFS_MIB" -lt "$DISK_MIB" ] || {
  echo "Rootfs ($ROOTFS_MIB MiB) does not fit in DISK_MIB=$DISK_MIB." >&2
  exit 1
}
mkdir -p "$SQUASH_ROOT/LiveOS"
truncate -s "${DISK_MIB}M" "$SQUASH_ROOT/LiveOS/rootfs.img"
# -m 0: no root reserve, the live root is disposable.
mke2fs -q -F -t ext4 -L lumiboot -m 0 -d "$ROOTFS" "$SQUASH_ROOT/LiveOS/rootfs.img"

echo "== 10. Live squashfs + bootable ISO (El-Torito) =="
# gzip decompresses much faster than xz under software emulation.
mkdir -p "$ISO_ROOT/LiveOS"
mksquashfs "$SQUASH_ROOT" "$ISO_ROOT/LiveOS/squashfs.img" \
  -comp gzip -noappend -all-root >/dev/null

# The disc boots itself: GRUB (BIOS El-Torito) loads the kernel and the
# initramfs from the ISO. v64 hard-codes the initrd window at 64 MiB whenever it
# injects a bzimage, and a Fedora kernel decompresses to ~74 MiB, overwriting
# that window mid-boot ("junk within compressed archive" + VFS panic). Letting
# the disc's own bootloader place kernel and initramfs removes the constraint.
cp "$KERNEL_IMAGE" "$ISO_ROOT/vmlinuz"
cp "$BUILD_DIR/initrd.img" "$ISO_ROOT/initrd.img"
mkdir -p "$ISO_ROOT/boot/grub"
cat > "$ISO_ROOT/boot/grub/grub.cfg" <<EOF
set timeout=0
set default=0

menuentry "Lumiboot Fedora" {
  linux /vmlinuz $LIVE_CMDLINE
  initrd /initrd.img
}
EOF
# -volid repeats the label the kernel command line already selects (CDLABEL):
# grub-mkrescue's own default is ISOIMAGE.
grub-mkrescue -o "$ARTIFACT_ISO" "$ISO_ROOT" -volid "$ISO_LABEL" >/dev/null

echo "== 11. Manifest + provenance (real sizes + SHA) =="
IMAGE_REF="$REF" IMAGE_ARCH="$ARCH" IMAGE_MEMORY_MIB="$MEMORY_MIB" IMAGE_VGA_MIB="$VGA_MIB" \
  IMAGE_CMDLINE="$LIVE_CMDLINE" \
  node "$HERE/write-manifest.mjs" "$BUILD_DIR"

{
  echo "flavor: $FLAVOR"
  echo "image-ref: $REF"
  echo "release: Fedora $FEDORA_RELEASEVER"
  echo "architecture: $ARCH"
  echo "mirror: $FEDORA_MIRROR"
  echo "gpg-key: $GPG_KEY"
  echo "kernel: $KERNEL_VERSION"
  echo "iso-label: $ISO_LABEL"
  echo "boot-path: grub-mkrescue El-Torito, kernel and initramfs on the disc"
  echo "ext4-size-mib: $DISK_MIB"
  echo "memory-mib: $MEMORY_MIB"
  echo "cmdline: $LIVE_CMDLINE"
  echo "packages: ${PACKAGES[*]}"
  echo "dnf: $(dnf --version 2>/dev/null | head -n1 || echo unknown)"
  echo "built-utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "note: the real SHA-256 of the artifacts are in manifest.json."
  echo "note: built locally by this script on a Linux host with dnf; not produced by CI, not signed by Fedora."
} > "$BUILD_DIR/provenance.txt"
cat "$BUILD_DIR/provenance.txt"

MARKER="LUMIBOOT_GUEST_READY:$REF"
if [ "$GRAPHICAL" = "true" ]; then
  MARKER="LUMIBOOT_DESKTOP_READY:$REF"
fi

cat <<EOF

Build complete (flavor=$FLAVOR, ref=$REF).

To publish into the application:
  mkdir -p "$HERE/../../apps/web/public/images/$REF"
  cp "$ARTIFACT_ISO"                   "$HERE/../../apps/web/public/images/$REF/"
  cp "$BUILD_DIR/vmlinuz"              "$HERE/../../apps/web/public/images/$REF/"
  cp "$BUILD_DIR/initrd.img"           "$HERE/../../apps/web/public/images/$REF/"
  cp "$BUILD_DIR/manifest.json"        "$HERE/../../apps/web/public/images/$REF/"

Expected guest marker on ttyS0 and on tty1: $MARKER

Then run the smoke test of images/fedora-44-x86-64/README.md.

A successful build proves nothing: a profile only stays validated:true while a
real boot in the browser still shows that marker. The XFCE variant stays
validated:false until such a boot has been recorded.
EOF
