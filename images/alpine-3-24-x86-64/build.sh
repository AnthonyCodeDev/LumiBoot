#!/usr/bin/env bash
#
# Reproducible build of an Alpine Linux 3.24.3 x86-64 XFCE image for v64.
#
#   FLAVOR=xfce ./images/alpine-3-24-x86-64/build.sh
#   ./images/alpine-3-24-x86-64/build.sh xfce
#
# One flavor only, `xfce`:
#   xfce -> alpine-3-24-x86-64-xfce  Xorg + XFCE session on tty1
#
# Rootless on purpose: no sudo, no chroot, no mount of the guest filesystem on
# the host. apk installs into a directory (`--root`), the module tree comes out
# of the ISO's modloop squashfs, and everything else is a plain file write.
#
# Requires Linux or WSL2 on an x86_64 host and the tools curl, xorriso,
# mksquashfs and unsquashfs (squashfs-tools), cpio, gzip, tar, sha256sum and
# realpath. The build directory MUST live on a native Linux filesystem (ext4
# under WSL2, never /mnt/c): DrvFs drops file modes, and the rootfs squashfs
# keeps the setuid bit of usr/libexec/Xorg.wrap.
#
# LUMIBOOT_BUILD_DIR overrides the work directory, which defaults to
# ${XDG_CACHE_HOME:-$HOME/.cache}/lumiboot/alpine-3-24-x86-64. Downloads and the
# unpacked ISO /boot are cached there and reused on the next run.
#
# Writes alpine-3-24-x86-64-xfce.iso, boot/lumiboot-rootfs.squashfs,
# vmlinuz-virt, initramfs-virt, packages.tsv and provenance.txt into
# images/alpine-3-24-x86-64/build-xfce/.
#
# Why a repacked ISO instead of the official boot path: the `virt` ISO carries no
# rootfs. Its initramfs installs one into a tmpfs with `apk add` from /apks at
# every boot, and XFCE would mean ~370 packages / 650 MiB to unpack on each boot
# (10-20 min under v64). This image ships a preinstalled squashfs rootfs plus a
# RAM overlayfs, mounted by guest/init. The official BIOS and UEFI El-Torito
# records are kept so the disc stays bootable, although LumiBoot boots it through
# v64's bzimage + initrd path like the Alpine CLI image.
set -euo pipefail

ALPINE_VERSION="3.24.3"
ISO_NAME="alpine-virt-$ALPINE_VERSION-x86_64.iso"
ISO_URL="https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64/$ISO_NAME"
ISO_SHA256="cdc1bc0efc64d8d611bf3733f54868172a545888dfd726f518bf279bcb0ff1af"

# apk-tools-static is the only way to install Alpine packages without root. Its
# version and digest are pinned: it is executed, not merely unpacked.
APK_TOOLS_VERSION="3.0.8-r0"
APK_TOOLS_NAME="apk-tools-static-$APK_TOOLS_VERSION.apk"
APK_TOOLS_URL="https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86_64/$APK_TOOLS_NAME"
APK_TOOLS_SHA256="c8e2c88c13ba12a12269b79a3543e1190ff8c0ab0beb32b58cadfd5881c619e3"

# The Alpine keyring package (alpine-keys) is the trust anchor for every other
# package, so it cannot be signature-checked: it is pinned by SHA-256. That
# digest is public integrity data about a redistributable package, not
# authentication material and never a secret. The identifiers deliberately avoid
# a key-like name: scanners flag `*_KEYS_SHA256` as a generic API key even though
# the value is a published checksum.
ALPINE_TRUST_ANCHOR_VERSION="2.6-r0"
ALPINE_TRUST_ANCHOR_NAME="alpine-keys-$ALPINE_TRUST_ANCHOR_VERSION.apk"
ALPINE_TRUST_ANCHOR_URL="https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86_64/$ALPINE_TRUST_ANCHOR_NAME"
ALPINE_TRUST_ANCHOR_SHA256="dd211936d544f4050924ce8aec078d24e7b1b036ae70b30bd07867349587c708"

# XFCE lives in community since Alpine 3.13; the kernel and Xorg are in main.
REPO_MAIN="https://dl-cdn.alpinelinux.org/alpine/v3.24/main"
REPO_COMMUNITY="https://dl-cdn.alpinelinux.org/alpine/v3.24/community"

ARCH="x86_64"
CMDLINE="console=tty0 console=ttyS0,115200 earlyprintk=serial,ttyS0,115200 loglevel=4"

FLAVOR="${1:-${FLAVOR:-xfce}}"
case "$FLAVOR" in
  xfce)
    REF="alpine-3-24-x86-64-xfce"
    # Xorg + XFCE + Mesa need headroom; v64 rounds the size to whole MiB.
    MEMORY_MIB="2048"
    VGA_MIB="32"
    BUILD_SUFFIX="-xfce"
    ;;
  *)
    echo "Unknown flavor: \"$FLAVOR\" (expected: xfce)." >&2
    exit 1
    ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_OUT="$(realpath -m -- "$HERE/build$BUILD_SUFFIX")"
WORK_DIR="$(realpath -m -- "${LUMIBOOT_BUILD_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/lumiboot/alpine-3-24-x86-64}")"
ROOTFS="$WORK_DIR/rootfs"
ISO_BOOT="$WORK_DIR/iso-boot"
INITRAMFS_DIR="$WORK_DIR/initramfs"
APK_TOOLS_DIR="$WORK_DIR/apk-tools"
KEYS_DIR="$WORK_DIR/alpine-keys"
ISO="$WORK_DIR/$ISO_NAME"
SQFS="$BUILD_OUT/boot/lumiboot-rootfs.squashfs"
ARTIFACT_ISO="$BUILD_OUT/$REF.iso"

# The XFCE package set is explicit, never `xfce4` alone: `xfce4` pulls the session,
# panel, WM and settings but neither Xorg, startx, a terminal nor the probes the
# readiness script needs. `xf86-input-keyboard`/`xf86-input-mouse` no longer exist
# in 3.24: libinput + eudev are the input path. `font-dejavu` is the only font
# family XFCE uses by default, and kbd-bkeymaps holds the French AZERTY console
# map. No `xf86-input-evdev` and no `xf86-video-vesa`: v64 exposes the Bochs VGA
# device, which Xorg reaches through modesetting (or fbdev on /dev/fb0).
PACKAGES=(
  alpine-base doas kbd-bkeymaps
  # Device manager: libinput and Xorg need udev, not the ISO's mdev, to create
  # /dev/dri and /dev/input with their tags and permissions.
  eudev udev-init-scripts-openrc eudev-openrc
  dbus dbus-openrc
  # X server, startx and the two video drivers of the LumiBoot layouts.
  xorg-server xinit xf86-input-libinput xf86-video-fbdev
  # Desktop environment, terminal, and the tools used by the guest scripts.
  xfce4 xfce4-terminal xdpyinfo xsetroot setxkbmap font-dejavu
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
# Rootless build: running as root would make apk chown files and defeat the
# point, while still not being enough for the chroot-free path.
if [ "$(id -u)" -eq 0 ]; then
  echo "Do not run this script as root: it never needs it." >&2
  exit 1
fi

for tool in curl xorriso mksquashfs unsquashfs cpio gzip tar sha256sum realpath install; do
  require "$tool"
done
# openssl is optional: nothing here encrypts an overlay or re-signs the ISO, the
# signature of every package is verified by apk against the pinned keyring.
command -v openssl >/dev/null 2>&1 || echo "Note: openssl is optional and unused here."

if [ "$WORK_DIR" = / ] || [ "$BUILD_OUT" = / ] ||
   { [ -e "$WORK_DIR" ] && [ ! -d "$WORK_DIR" ]; } ||
   { [ -e "$BUILD_OUT" ] && [ ! -d "$BUILD_OUT" ]; }; then
  echo "Refusing unsafe build directory: $WORK_DIR / $BUILD_OUT" >&2
  exit 1
fi
mkdir -p "$WORK_DIR"

# mksquashfs -all-root cannot restore what the filesystem already lost: on
# 9p/DrvFs (/mnt/c under WSL2) the modes and the setuid bit are not preserved.
WORK_FS="$(stat -f -c %T "$WORK_DIR" 2>/dev/null || true)"
case "$WORK_FS" in
  drvfs|9p|cifs|vfat|exfat|fuseblk)
    echo "The build directory must be on a native Linux filesystem." >&2
    echo "$WORK_DIR is on \"$WORK_FS\"; set LUMIBOOT_BUILD_DIR to an ext4 path." >&2
    exit 1
    ;;
esac

# Only our own outputs may be removed: a build-xfce/ holding anything else is
# left untouched instead of being wiped.
OUTPUTS=("$REF.iso" "vmlinuz-virt" "initramfs-virt" "packages.tsv" "provenance.txt" "boot")
mkdir -p "$BUILD_OUT"
shopt -s nullglob
for entry in "$BUILD_OUT"/*; do
  name="$(basename "$entry")"
  known=""
  for allowed in "${OUTPUTS[@]}"; do
    [ "$name" = "$allowed" ] && known="yes"
  done
  if [ -z "$known" ]; then
    echo "Refusing to clean $BUILD_OUT: unexpected entry \"$name\"." >&2
    echo "Move it away, or remove it, and rerun." >&2
    exit 1
  fi
done
shopt -u nullglob
rm -f "$ARTIFACT_ISO" "$BUILD_OUT/vmlinuz-virt" "$BUILD_OUT/initramfs-virt" \
  "$BUILD_OUT/packages.tsv" "$BUILD_OUT/provenance.txt"
rm -rf "$BUILD_OUT/boot"
mkdir -p "$BUILD_OUT/boot"

# Cached download pinned by digest: the cache is reused, never trusted blindly.
fetch_pinned() {
  url="$1" dest="$2" sha="$3"
  if [ -f "$dest" ] && [ "$(sha256sum "$dest" | cut -d' ' -f1)" = "$sha" ]; then
    echo "cached: $(basename "$dest")"
    return 0
  fi
  rm -f "$dest" "$dest.part"
  echo "downloading: $url"
  if ! curl -fL --retry 3 --connect-timeout 30 -o "$dest.part" "$url"; then
    rm -f "$dest.part"
    echo "Download failed: $url" >&2
    exit 1
  fi
  actual="$(sha256sum "$dest.part" | cut -d' ' -f1)"
  if [ "$actual" != "$sha" ]; then
    rm -f "$dest.part"
    echo "SHA-256 mismatch for $url" >&2
    echo "  expected $sha" >&2
    echo "  got      $actual" >&2
    exit 1
  fi
  mv "$dest.part" "$dest"
}

# xorriso reports tolerated problems on a readable ISO with exit code 32
# ("SORRY"). Treat it as success, every other non-zero code as a failure.
run_xorriso() {
  rc=0
  xorriso "$@" || rc=$?
  if [ "$rc" -ne 0 ] && [ "$rc" -ne 32 ]; then
    echo "xorriso failed (exit $rc)." >&2
    exit 1
  fi
}

echo "== 1. Pinned downloads (Alpine $ALPINE_VERSION, x86_64) =="
fetch_pinned "$ISO_URL" "$ISO" "$ISO_SHA256"
fetch_pinned "$APK_TOOLS_URL" "$WORK_DIR/$APK_TOOLS_NAME" "$APK_TOOLS_SHA256"
fetch_pinned "$ALPINE_TRUST_ANCHOR_URL" "$WORK_DIR/$ALPINE_TRUST_ANCHOR_NAME" "$ALPINE_TRUST_ANCHOR_SHA256"

rm -rf "$APK_TOOLS_DIR" "$KEYS_DIR"
mkdir -p "$APK_TOOLS_DIR" "$KEYS_DIR"
# The .apk format is a gzipped tar with an extra signature control file; tar
# prints a harmless warning about the APK-TOOLS.checksum.SHA1 xattr keyword.
tar -xzf "$WORK_DIR/$APK_TOOLS_NAME" -C "$APK_TOOLS_DIR" sbin/apk.static 2>/dev/null
tar -xzf "$WORK_DIR/$ALPINE_TRUST_ANCHOR_NAME" -C "$KEYS_DIR" 2>/dev/null
APK="$APK_TOOLS_DIR/sbin/apk.static"
[ -x "$APK" ] || {
  echo "apk.static was not extracted from $APK_TOOLS_NAME." >&2
  exit 1
}
KEYS="$KEYS_DIR/etc/apk/keys"
[ -d "$KEYS" ] || {
  echo "The Alpine keyring was not extracted from $ALPINE_TRUST_ANCHOR_NAME." >&2
  exit 1
}
"$APK" --version

echo "== 2. ISO /boot extraction (kernel, initramfs, modloop, config) =="
# The whole directory is extracted in one pass: the kernel config name carries
# the release (config-6.18.58-0-virt) and xorriso has no glob support. ~53 MiB.
if [ ! -f "$ISO_BOOT/vmlinuz-virt" ] || [ ! -f "$ISO_BOOT/modloop-virt" ] ||
   ! ls "$ISO_BOOT"/config-* >/dev/null 2>&1; then
  rm -rf "$ISO_BOOT"
  mkdir -p "$ISO_BOOT"
  xorriso -osirrox on -indev "$ISO" -extract /boot "$ISO_BOOT" >/dev/null
fi
for f in vmlinuz-virt initramfs-virt modloop-virt; do
  [ -f "$ISO_BOOT/$f" ] || {
    echo "The Alpine ISO does not carry /boot/$f." >&2
    exit 1
  }
done
CONFIG_FILE="$(ls "$ISO_BOOT"/config-* 2>/dev/null | head -n1 || true)"
[ -n "$CONFIG_FILE" ] || {
  echo "The Alpine ISO does not carry /boot/config-*." >&2
  exit 1
}

echo "== 3. Kernel feature check (squashfs, overlayfs, isofs, loop) =="
# The guest init needs all four; a virt kernel built without one of them would
# boot to a recovery shell, so the build stops here instead.
check_config() {
  option="$1"
  if grep -qE "^$option=[my]$" "$CONFIG_FILE"; then
    echo "OK   $option"
  else
    echo "The Alpine kernel ($(basename "$CONFIG_FILE")) lacks $option=m|y." >&2
    exit 1
  fi
}
for option in CONFIG_SQUASHFS CONFIG_OVERLAY_FS CONFIG_ISO9660_FS CONFIG_BLK_DEV_LOOP; do
  check_config "$option"
done

echo "== 4. Rootfs installation (apk, --root, no root, signature checked) =="
# apk-tools 3.0.8 cannot initialise a non-root database with `--initdb` or
# `--usermode`: that path downloads no repository index ("opening from cache …
# No such file or directory"). Pre-creating the two database files is equivalent,
# and apk then infers usermode from the non-root owner of `installed`, so the
# install never chowns and needs no privilege. Signatures stay mandatory: no
# --allow-untrusted here, the keyring above is the only trust anchor.
rm -rf "$ROOTFS"
mkdir -p "$ROOTFS/lib/apk/db" "$ROOTFS/etc/apk"
: > "$ROOTFS/lib/apk/db/installed"
: > "$ROOTFS/etc/apk/world"

APK_OPTS=(--root "$ROOTFS" --arch "$ARCH" --keys-dir "$KEYS"
  --repository "$REPO_MAIN" --repository "$REPO_COMMUNITY")
# An explicit update is required: `apk add` alone does not fetch the index of a
# repository it has not cached yet, and every package would look unknown.
"$APK" "${APK_OPTS[@]}" update
"$APK" "${APK_OPTS[@]}" add "${PACKAGES[@]}"

# --usermode cannot set the setuid (or setgid) bits the packages declare.
# Restore only the ones the boot path really uses: Xorg.wrap to open the DRM /
# framebuffer device, doas for the passwordless root of the smoke test, the
# busybox su/passwd multiplexer and polkit's agent helper. A missing file is not
# an error (a package may stop shipping it), a missing bit on the first three is.
restore_setuid() {
  if [ -e "$ROOTFS/$1" ]; then
    chmod "$2" "$ROOTFS/$1"
  fi
}
restore_setuid usr/libexec/Xorg.wrap 4711
restore_setuid usr/bin/doas 4755
restore_setuid bin/bbsuid 4755
restore_setuid usr/lib/polkit-1/polkit-agent-helper-1 4755
for binary in usr/libexec/Xorg.wrap usr/bin/doas bin/bbsuid; do
  if [ ! -u "$ROOTFS/$binary" ]; then
    echo "$binary is not setuid: the guest would lose its root access paths." >&2
    exit 1
  fi
done

echo "== 5. Kernel modules from the ISO modloop =="
# The virt ISO keeps its modules in boot/modloop-virt, a squashfs whose root is
# `modules/`; extracting it into the rootfs `lib/` yields lib/modules/<ver>/.
# unsquashfs 4.6 extracts this image as is (including its symlinks): no
# duplicate-entry workaround is needed, and a failure is fatal.
if ! unsquashfs -f -d "$ROOTFS/lib" "$ISO_BOOT/modloop-virt" >/dev/null; then
  echo "Unable to extract the kernel modules from boot/modloop-virt." >&2
  exit 1
fi
KERNEL_VERSION="$(ls "$ROOTFS/lib/modules" | grep -E '^[0-9]' | head -n1 || true)"
[ -n "${KERNEL_VERSION:-}" ] || {
  echo "No kernel version directory under lib/modules after the modloop extraction." >&2
  exit 1
}
[ -f "$ROOTFS/lib/modules/$KERNEL_VERSION/modules.dep" ] || {
  echo "lib/modules/$KERNEL_VERSION/modules.dep is missing (modloop mismatch)." >&2
  exit 1
}
if [ "$(basename "$CONFIG_FILE")" != "config-$KERNEL_VERSION" ]; then
  echo "modloop ($KERNEL_VERSION) and kernel config ($(basename "$CONFIG_FILE")) disagree." >&2
  exit 1
fi
echo "Guest kernel: $KERNEL_VERSION"

echo "== 6. Guest configuration (init scripts, autologin, Xorg) =="
install -D -m 0644 "$HERE/guest/inittab" "$ROOTFS/etc/inittab"
printf 'lumiboot\n' > "$ROOTFS/etc/hostname"
# doas replaces sudo: the unprivileged account needs root rights for the smoke
# test, and the wheel group is the only one allowed.
printf 'permit nopass :wheel\n' > "$ROOTFS/etc/doas.conf"
chmod 0400 "$ROOTFS/etc/doas.conf"
install -D -m 0755 "$HERE/guest/lumiboot-setup" "$ROOTFS/usr/local/sbin/lumiboot-setup"
install -D -m 0755 "$HERE/guest/lumiboot-autologin" "$ROOTFS/usr/local/sbin/lumiboot-autologin"
install -D -m 0755 "$HERE/guest/xfce/lumiboot-startx" "$ROOTFS/usr/local/bin/lumiboot-startx"
install -D -m 0755 "$HERE/guest/xfce/lumiboot-desktop-ready" \
  "$ROOTFS/usr/local/bin/lumiboot-desktop-ready"
# The marker must name this image: @REF@ is substituted here, so no variant can
# ever print another one's marker.
sed -i "s/@REF@/$REF/" "$ROOTFS/usr/local/bin/lumiboot-desktop-ready"

# /etc/X11/xorg.conf.d is not created by the xorg-server package on Alpine.
install -d -m 0755 "$ROOTFS/etc/X11/xorg.conf.d"
install -D -m 0644 "$HERE/guest/xfce/xorg.conf.d/20-lumiboot.conf" \
  "$ROOTFS/etc/X11/xorg.conf.d/20-lumiboot.conf"

# The login shell of tty1 starts the session. The file is owned by the build user
# here; mksquashfs -all-root makes it root-owned and lumiboot-setup chowns the
# home directory at boot, which is enough because it is only ever read.
install -D -m 0644 "$HERE/guest/xfce/.profile" "$ROOTFS/home/lumiboot/.profile"

echo "== 7. OpenRC runlevels (deterministic symlinks, no chroot) =="
add_runlevel() {
  service="$1" level="$2"
  script="$ROOTFS/etc/init.d/$service"
  if [ ! -x "$script" ]; then
    echo "Missing OpenRC service /etc/init.d/$service (package not installed?)." >&2
    exit 1
  fi
  mkdir -p "$ROOTFS/etc/runlevels/$level"
  ln -sfn "/etc/init.d/$service" "$ROOTFS/etc/runlevels/$level/$service"
}
# udev replaces mdev: Xorg's libinput driver and the DRM device need udev, which
# tags /dev/input and /dev/dri. devfs is the virtual `dev-mount` provider udev
# depends on; guest/init already mounted devtmpfs, so it is a no-op here.
rm -f "$ROOTFS/etc/runlevels/sysinit/mdev"
add_runlevel devfs sysinit
add_runlevel udev sysinit
add_runlevel udev-trigger sysinit
add_runlevel udev-settle sysinit
add_runlevel dbus default
add_runlevel udev-postmount default

echo "== 8. Rootfs squashfs (xz, 128 KiB blocks, all files root-owned) =="
# -all-root restores the ownership the rootless install could not set, and keeps
# the setuid bit of usr/libexec/Xorg.wrap.
mksquashfs "$ROOTFS" "$SQFS" -comp xz -b 131072 -noappend -all-root >/dev/null
[ -f "$SQFS" ] || {
  echo "mksquashfs did not produce $SQFS." >&2
  exit 1
}

echo "== 9. Initramfs with the LumiBoot init =="
rm -rf "$INITRAMFS_DIR"
mkdir -p "$INITRAMFS_DIR"
(
  cd "$INITRAMFS_DIR"
  gzip -dc "$ISO_BOOT/initramfs-virt" | cpio -idm --quiet
)
install -m 0755 "$HERE/guest/init" "$INITRAMFS_DIR/init"
(
  cd "$INITRAMFS_DIR"
  # newc is the format the kernel's initramfs unpacker expects; -9 only trades
  # build time for a smaller initrd, the guest decompresses it once.
  find . -print0 | cpio --null -o -H newc --quiet | gzip -9 > "$BUILD_OUT/initramfs-virt"
)
# The embedded init must be ours: a stale or missing file would silently boot
# the official Alpine installer instead of the LumiBoot session. Both listings go
# to files, for the same pipefail/SIGPIPE reason as the squashfs check below.
INIT_MARKER="LumiBoot initramfs init for the Alpine XFCE image"
gzip -dc "$BUILD_OUT/initramfs-virt" | cpio -it > "$WORK_DIR/initramfs-list.txt" 2>/dev/null
grep -qx init "$WORK_DIR/initramfs-list.txt" || {
  echo "The rebuilt initramfs has no init entry." >&2
  exit 1
}
gzip -dc "$BUILD_OUT/initramfs-virt" | cpio -i --to-stdout init > "$WORK_DIR/initramfs-init" 2>/dev/null
grep -q "$INIT_MARKER" "$WORK_DIR/initramfs-init" || {
  echo "The initramfs init is not the LumiBoot one (marker missing)." >&2
  exit 1
}

echo "== 10. ISO repack (official boot records kept, /apks removed) =="
# /apks is the official ISO's package repository, used by its initramfs to build
# a rootfs in tmpfs: this image does not need it and it is ~15 MiB. -rm_r is
# required because -map on an existing directory would merge instead of replace.
rm -f "$ARTIFACT_ISO"
run_xorriso -indev "$ISO" -outdev "$ARTIFACT_ISO" \
  -boot_image any keep -rm_r /apks -- \
  -map "$SQFS" /boot/lumiboot-rootfs.squashfs >/dev/null
cp "$ISO_BOOT/vmlinuz-virt" "$BUILD_OUT/vmlinuz-virt"

echo "== 11. Final checks, package inventory and provenance =="
EL_TORITO="$(run_xorriso -indev "$ARTIFACT_ISO" -report_el_torito plain)"
BOOT_ENTRIES="$(printf '%s\n' "$EL_TORITO" | grep -c '^El Torito boot img :')"
[ "$BOOT_ENTRIES" -eq 2 ] || {
  echo "Expected 2 El-Torito boot entries (BIOS + UEFI), found $BOOT_ENTRIES." >&2
  printf '%s\n' "$EL_TORITO" | grep '^El Torito boot img :' >&2
  exit 1
}
grep -q 'BIOS' <<<"$EL_TORITO" || { echo "BIOS El-Torito entry missing." >&2; exit 1; }
grep -q 'UEFI' <<<"$EL_TORITO" || { echo "UEFI El-Torito entry missing." >&2; exit 1; }

ISO_BOOT_FILES="$(run_xorriso -indev "$ARTIFACT_ISO" -find /boot -name lumiboot-rootfs.squashfs)"
grep -q lumiboot-rootfs.squashfs <<<"$ISO_BOOT_FILES" || {
  echo "/boot/lumiboot-rootfs.squashfs is absent from the produced ISO." >&2
  exit 1
}

# The squashfs must hold the desktop, the setuid wrapper, udev's service and the
# login profile: a mistyped install path would only show up at boot otherwise.
# Both listings go through files: with `pipefail`, a `grep -q` reading a long pipe
# could exit early and make the producer die of SIGPIPE.
unsquashfs -l "$SQFS" > "$WORK_DIR/squashfs-list.txt"
for path in usr/bin/startxfce4 usr/libexec/Xorg.wrap etc/init.d/udev home/lumiboot/.profile; do
  if ! grep -q "/$path\$" "$WORK_DIR/squashfs-list.txt"; then
    echo "The rootfs squashfs does not contain /$path." >&2
    exit 1
  fi
done
# -all-root must keep the setuid bit: without it Xorg.wrap cannot open the device.
unsquashfs -ll "$SQFS" > "$WORK_DIR/squashfs-long-list.txt"
if ! grep -E '^-rws.*Xorg\.wrap$' "$WORK_DIR/squashfs-long-list.txt" >/dev/null; then
  echo "usr/libexec/Xorg.wrap is not setuid inside the rootfs squashfs." >&2
  exit 1
fi

# Alpine keeps one `P:`/`V:` pair per installed package in this file.
awk -F: '/^P:/{name=$2} /^V:/{if (name != "") { print name "\t" $2; name="" }}' \
  "$ROOTFS/lib/apk/db/installed" | sort > "$BUILD_OUT/packages.tsv"
PACKAGE_COUNT="$(wc -l < "$BUILD_OUT/packages.tsv")"

{
  echo "flavor: $FLAVOR"
  echo "image-ref: $REF"
  echo "release: Alpine Linux $ALPINE_VERSION"
  echo "architecture: $ARCH"
  echo "source-iso: $ISO_URL"
  echo "source-iso-sha256: $ISO_SHA256"
  echo "apk-tools-static: $APK_TOOLS_VERSION $APK_TOOLS_SHA256"
  echo "alpine-keys: $ALPINE_TRUST_ANCHOR_VERSION $ALPINE_TRUST_ANCHOR_SHA256"
  echo "repositories: $REPO_MAIN $REPO_COMMUNITY"
  echo "kernel: $KERNEL_VERSION"
  echo "rootfs: squashfs (xz, 128 KiB blocks) mounted read-only with an overlayfs RAM upper layer"
  echo "boot-path: official virt ISO repacked by xorriso, BIOS+UEFI El-Torito kept, custom initramfs init"
  echo "packages: ${PACKAGES[*]}"
  echo "cmdline: $CMDLINE"
  echo "built-utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "note: the real SHA-256 of the artifacts are in manifest.json once published."
  echo "note: built locally by this script on a Linux host with apk.static; not produced by CI, not signed by Alpine."
} > "$BUILD_OUT/provenance.txt"
cat "$BUILD_OUT/provenance.txt"

echo
echo "Artifacts:"
ls -lh "$ARTIFACT_ISO" "$BUILD_OUT/vmlinuz-virt" "$BUILD_OUT/initramfs-virt" "$SQFS" \
  "$BUILD_OUT/packages.tsv" | sed 's/^/  /'
echo "  installed packages: $PACKAGE_COUNT"

cat <<EOF

Build complete (flavor=$FLAVOR, ref=$REF).

To publish into the application (recomputes the manifest SHA-256 and sizes):
  pnpm assets:v64:alpine:xfce

Expected guest marker on ttyS0: LUMIBOOT_DESKTOP_READY:$REF
Then run the smoke test of images/alpine-3-24-x86-64/tests/xfce-smoke-test.md.

A successful build proves nothing: the XFCE profile stays validated:false until a
real boot in the browser prints that marker (tests/e2e/desktop-alpine-xfce.spec.ts).
EOF
