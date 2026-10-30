#!/usr/bin/env bash
#
# Reproducible build of a Fedora 44 x86-64 live image for v64.
#
#   sudo ./images/fedora-44-x86-64/build.sh
#   sudo FEDORA_RELEASEVER=44 FEDORA_MIRROR=https://mirror.example/fedora ./images/fedora-44-x86-64/build.sh
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
# Writes vmlinuz, initrd.img, fedora-44-x86-64.iso, manifest.json, packages.tsv
# and provenance.txt into build/. The ISO carries the kernel, the initramfs and
# a GRUB El-Torito boot record: the guest boots from the disc itself.
set -euo pipefail

REF="fedora-44-x86-64"
ARCH="x86_64"
FEDORA_RELEASEVER="${FEDORA_RELEASEVER:-44}"
FEDORA_MIRROR="${FEDORA_MIRROR:-https://download.fedoraproject.org/pub/fedora/linux}"
ISO_LABEL="${ISO_LABEL:-LUMIBOOT-FEDORA}"
MEMORY_MIB="1024"
VGA_MIB="32"
# Size of the ext4 filesystem stored inside the live squashfs. The empty space
# compresses to almost nothing, so the default stays generous.
DISK_MIB="${DISK_MIB:-2048}"

# dracut finds the live root through the ISO label, hence CDLABEL. `rd.live.image`
# asks dmsquash-live for the live image layout (LiveOS/squashfs.img) and
# `selinux=0` avoids an overlay without labels; `loglevel=4` keeps the serial
# log readable under emulation.
LIVE_CMDLINE="console=tty0 console=ttyS0,115200 root=live:CDLABEL=$ISO_LABEL rd.live.image selinux=0 loglevel=4"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The build directory can live on a native ext4 filesystem outside the
# repository: chroot and mke2fs -d fail on 9p/DrvFs mounts.
DEFAULT_BUILD_DIR="$(realpath -m -- "$HERE/build")"
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

echo "== 2. Package installation (minimal live guest) =="
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

# systemd-vconsole-setup applies this at sysinit; lumiboot-ready re-applies it.
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

echo "== 6. Autologin on tty1 and ttyS0 + readiness marker =="
install -D -m 0644 "$HERE/guest/getty-autologin.conf" \
  "$ROOTFS/etc/systemd/system/getty@tty1.service.d/autologin.conf"
install -D -m 0644 "$HERE/guest/serial-getty-autologin.conf" \
  "$ROOTFS/etc/systemd/system/serial-getty@ttyS0.service.d/autologin.conf"
install -D -m 0644 "$HERE/guest/lumiboot-ready.service" \
  "$ROOTFS/etc/systemd/system/lumiboot-ready.service"

chroot "$ROOTFS" bash -e -c '
  systemctl enable getty@tty1.service serial-getty@ttyS0.service lumiboot-ready.service
  # An empty /etc/machine-id counts as a first boot: systemd-firstboot would sit
  # on the console asking questions instead of handing the shell to the visitor.
  systemctl mask systemd-firstboot.service >/dev/null
'

echo "== 7. initramfs: dracut live stack + CD polling =="
# --no-hostonly: the build host's storage stack (NVMe, virtio) is not the
# emulated IDE/ATAPI CD of v64, so every storage driver must be embedded.
# dmsquash-live mounts squashfs.img from the ISO; pollcdrom waits for the ATAPI
# device to answer before the mount is attempted.
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
  echo "image-ref: $REF"
  echo "release: Fedora $FEDORA_RELEASEVER"
  echo "architecture: $ARCH"
  echo "mirror: $FEDORA_MIRROR"
  echo "gpg-key: $GPG_KEY"
  echo "kernel: $KERNEL_VERSION"
  echo "iso-label: $ISO_LABEL"
  echo "boot-path: grub-mkrescue El-Torito, kernel and initramfs on the disc"
  echo "ext4-size-mib: $DISK_MIB"
  echo "cmdline: $LIVE_CMDLINE"
  echo "packages: ${PACKAGES[*]}"
  echo "dnf: $(dnf --version 2>/dev/null | head -n1 || echo unknown)"
  echo "built-utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "note: the real SHA-256 of the artifacts are in manifest.json."
  echo "note: built locally by this script on a Linux host with dnf; not produced by CI, not signed by Fedora."
} > "$BUILD_DIR/provenance.txt"
cat "$BUILD_DIR/provenance.txt"

cat <<EOF

Build complete (ref=$REF).

To publish into the application:
  mkdir -p "$HERE/../../apps/web/public/images/$REF"
  cp "$ARTIFACT_ISO"                   "$HERE/../../apps/web/public/images/$REF/"
  cp "$BUILD_DIR/vmlinuz"              "$HERE/../../apps/web/public/images/$REF/"
  cp "$BUILD_DIR/initrd.img"           "$HERE/../../apps/web/public/images/$REF/"
  cp "$BUILD_DIR/manifest.json"        "$HERE/../../apps/web/public/images/$REF/"

Then run the smoke test of images/fedora-44-x86-64/README.md.

A successful build proves nothing: the profile stays validated:false until a real
boot in the browser has shown the LUMIBOOT_GUEST_READY:fedora-44-x86-64 marker.
EOF
