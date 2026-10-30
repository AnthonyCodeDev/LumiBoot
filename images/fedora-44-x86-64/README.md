# Fedora 44 x86-64 for v64

One script builds a minimal Fedora 44 x86-64 live console: a `dnf --installroot`
rootfs, packed as an ext4 image inside a squashfs, plus a bootable ISO. The
profile is `validated: true`: a real boot in the browser has booted it and
printed its marker.

| Element | Value |
|---|---|
| Reference | `fedora-44-x86-64` |
| RAM / VGA | 1024 MiB / 32 MiB |
| Boot path | `cdrom` only: the ISO boots itself (GRUB on El-Torito) |
| Live layout | `LiveOS/squashfs.img` → `LiveOS/rootfs.img` (ext4) |
| Session | `lumiboot` autologin on tty1 and ttyS0, text console |
| Readiness | `LUMIBOOT_GUEST_READY:fedora-44-x86-64` |

## Build

Linux or WSL2 on an x86_64 host, root, and: `dnf`, `rpm`, `dracut`,
`squashfs-tools` (`mksquashfs`), `e2fsprogs` (`mke2fs`), `xorriso`,
`grub-mkrescue` (`grub-common` + `grub-pc-bin` + `mtools` on Debian/Ubuntu),
`cpio`, `xz`, `node`. The Fedora GPG key of the release must be present
(`/etc/pki/rpm-gpg/RPM-GPG-KEY-fedora-44-primary`): packages are signature
checked, never installed from an unauthenticated mirror. Never native Windows.

```bash
sudo ./images/fedora-44-x86-64/build.sh
```

Outputs in `build/`: `vmlinuz`, `initrd.img`, `fedora-44-x86-64.iso` (holding
`vmlinuz`, `initrd.img`, `LiveOS/squashfs.img` and `boot/grub/grub.cfg`),
`manifest.json`, `packages.tsv`, `provenance.txt`.
Variables: `FEDORA_RELEASEVER` (default `44`), `FEDORA_MIRROR`, `ISO_LABEL`
(default `LUMIBOOT-FEDORA`), `DISK_MIB` (default `2048`), `LUMIBOOT_BUILD_DIR`.

Packages: `fedora-release`, `basesystem`, `systemd`, `systemd-udev`,
`kernel-core`, `dracut`, `dracut-live`, `e2fsprogs`, `bash`, `coreutils`,
`util-linux`, `shadow-utils`, `passwd`, `sudo`, `kbd`, `procps-ng`, `grep`,
`sed`, `tar`, `gzip`, `xz`. Nothing else: the image stays small and the boot
path stays auditable.

## Boot path: El-Torito, not `bzimage`

The ISO carries a GRUB boot record (BIOS El-Torito), its own `vmlinuz`,
`initrd.img` and `boot/grub/grub.cfg`; the manifest marks it
`boot.cdromOnly: true`. The engine therefore injects no kernel, and the guest
boots the way a physical Fedora disc does.

This is not cosmetic. When v64 injects a `bzimage`, `libv86.mjs` hard-codes the
initrd load window at 64 MiB (`h=67108864` in the bzimage loader). A 32-bit
Debian/Ubuntu kernel decompresses below that limit, but the Fedora 44 kernel
decompresses to ~74 MiB and overwrites the initrd while booting, which ends in
`Initramfs unpacking failed: junk within compressed archive` then
`Kernel panic - not syncing: VFS: Unable to mount root fs on unknown-block(0,0)`.
v86 exposes no `initrd_addr` option, and the kernel's own decompressor picks the
address, so the only reliable fix is to let the disc's bootloader place kernel
and initramfs in RAM.

The provider buffers the ISO synchronously (`cdrom`, no `async`): with ranged
ATAPI reads the guest logged `Emask 0x2 (HSM violation)` / `BMDMA stat 0x5` and
the stalled CD reads starved udev until `dev-ttyS0.device` timed out, which
killed the serial getty in one run out of three.

## Publishing

Copy the four artifacts into the Git-ignored `apps/web/public/images/fedora-44-x86-64/`:

```bash
mkdir -p apps/web/public/images/fedora-44-x86-64
cp images/fedora-44-x86-64/build/{fedora-44-x86-64.iso,vmlinuz,initrd.img,manifest.json} \
  apps/web/public/images/fedora-44-x86-64/
```

Assets are Git-ignored and `manifest.json` is never committed: `write-manifest.mjs`
computes the real sizes and SHA-256 values at build time.

## cmdline

```
console=tty0 console=ttyS0,115200 root=live:CDLABEL=LUMIBOOT-FEDORA rd.live.image selinux=0 loglevel=4
```

`root=live:CDLABEL=…` selects the ISO by its volume label, `rd.live.image` tells
dmsquash-live to use the `LiveOS/squashfs.img` layout, `selinux=0` avoids an
overlay without labels, `loglevel=4` keeps the serial log readable under
emulation. Guest writes go to the RAM overlay and are lost on stop.

## Smoke test

After a boot, on the VGA screen or the COM1 log:

```bash
uname -m                        # x86_64
cat /etc/os-release | head -1   # NAME="Fedora Linux"
id -un                          # lumiboot
sudo -n whoami                  # root
test -f /etc/lumiboot-azerty-ready && echo AZERTY_OK
```

The serial log ends with `LUMIBOOT_GUEST_READY:fedora-44-x86-64`; the same marker
is also written to tty1. A JavaScript timer is never a successful boot.

## Validation

`validated: true` in `packages/catalog/src/profiles.ts`: the real boot is proven
by `tests/e2e/session-fedora.spec.ts`, which boots the published image in
Chromium, waits for `LUMIBOOT_GUEST_READY:fedora-44-x86-64` (emitted by
`lumiboot-ready.service`, never by the client), then types the smoke-test
commands on ttyS0 and checks their output.

```bash
VM_E2E_ASSETS=1 pnpm test:e2e tests/e2e/session-fedora.spec.ts
```

The spec asserts the command output through sentinels (`UNAME:`, `USER:`,
`SUDO:`, `OS:`): the serial textarea also shows the OSC 3008 shell context that
systemd prints, which no plain text console renders.

The spec skips without the published assets and `apps/web/public/v64/v86.wasm`.
A JavaScript timer or a client-side string is never accepted as a successful
boot.
