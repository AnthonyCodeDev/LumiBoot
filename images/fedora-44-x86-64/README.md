# Fedora 44 x86-64 for v64

One script, two variants — like Debian and Ubuntu:

| Variant | Reference | Session | RAM | ext4 disk | Marker |
|---|---|---|---|---|---|
| CLI | `fedora-44-x86-64` | `lumiboot` autologin on tty1 and ttyS0, text console | 1024 MiB | 2048 MiB | `LUMIBOOT_GUEST_READY` |
| XFCE (default card variant) | `fedora-44-x86-64-xfce` | Xorg + XFCE on tty1, text shell on ttyS0 | 2048 MiB | 4096 MiB | `LUMIBOOT_DESKTOP_READY` |

Both are a `dnf --installroot` rootfs packed as an ext4 image inside a
squashfs, plus a bootable ISO (GRUB El-Torito). XFCE is the default variant of
the card (`variantOrder: 1`, as on Debian and Ubuntu) and carries
`validated: true` by operator decision: its ISO is built and published, so
both variants are launchable. No E2E boot has been recorded for XFCE yet (see
[Validation](#validation)). The CLI profile is `validated: true` too (a real
browser boot printed its marker).

XFCE is the default *card* variant (`variantOrder: 1`, as on Debian/Ubuntu),
while `build.sh` defaults to `FLAVOR=cli`, exactly like the Debian script
defaults to `minimal`.

## Build

Linux or WSL2 on an x86_64 host, root, and: `dnf`, `rpm`, `dracut`,
`squashfs-tools` (`mksquashfs`), `e2fsprogs` (`mke2fs`), `xorriso`,
`grub-mkrescue` (`grub-common` + `grub-pc-bin` + `mtools` on Debian/Ubuntu),
`cpio`, `xz`, `node`. The Fedora GPG key of the release must be present
(`/etc/pki/rpm-gpg/RPM-GPG-KEY-fedora-44-primary`): packages are signature
checked, never installed from an unauthenticated mirror. Never native Windows:
`dnf --installroot`, `chroot` and `mke2fs -d` need a Linux filesystem.

```bash
sudo ./images/fedora-44-x86-64/build.sh                 # CLI, ref fedora-44-x86-64
sudo FLAVOR=xfce ./images/fedora-44-x86-64/build.sh     # XFCE, ref fedora-44-x86-64-xfce
sudo ./images/fedora-44-x86-64/build.sh xfce            # same, flavor as first argument
```

An unknown flavor stops the script (`Unknown flavor: "…" (expected: cli | xfce)`).
Nothing else changes: `cli` keeps the reference, the ISO label, the RAM, the
disk size and the package list it always had.

| Flavor | `REF` | `BUILD_DIR` | `ISO_LABEL` | RAM | `DISK_MIB` |
|---|---|---|---|---|---|
| `cli` | `fedora-44-x86-64` | `build/` | `LUMIBOOT-FEDORA` | 1024 | 2048 |
| `xfce` | `fedora-44-x86-64-xfce` | `build-xfce/` | `LUMIBOOT-FEDORA-XFCE` | 2048 | 4096 |

The two ISOs must never share a volume label: `root=live:CDLABEL=…` is the only
way the initramfs finds its medium, so the label is per flavor (and
`ISO_LABEL`/`DISK_MIB`/`LUMIBOOT_BUILD_DIR`/`FEDORA_RELEASEVER`/`FEDORA_MIRROR`
still override their defaults).

Outputs in `build/` or `build-xfce/`: `vmlinuz`, `initrd.img`, `<ref>.iso`
(holding `vmlinuz`, `initrd.img`, `LiveOS/squashfs.img` and `boot/grub/grub.cfg`),
`manifest.json`, `packages.tsv`, `provenance.txt` (`provenance.txt` records the
flavor, the reference, the ISO label, the RAM and the disk size).

### Packages

Base list, both flavors: `fedora-release`, `basesystem`, `systemd`,
`systemd-udev`, `kernel-core`, `dracut`, `dracut-live`, `e2fsprogs`, `bash`,
`coreutils`, `util-linux`, `shadow-utils`, `passwd`, `sudo`, `kbd`,
`procps-ng`, `grep`, `sed`, `tar`, `gzip`, `xz`.

XFCE addition, `FLAVOR=xfce` only:

| Group | Packages |
|---|---|
| DRM/input kernel modules | `kernel-modules` |
| X server and launch | `xorg-x11-server-Xorg`, `xorg-x11-xinit` |
| Input and keymap | `xorg-x11-drv-libinput`, `xkbcomp` |
| Probes and screen utilities | `xdpyinfo`, `xrandr`, `xprop` |
| XFCE | `xfce4-session`, `xfwm4`, `xfce4-panel`, `xfdesktop`, `xfce4-settings`, `xfconf`, `thunar`, `xfce4-terminal`, `xfce4-appfinder` |
| Fonts and software GL | `dejavu-sans-fonts`, `mesa-dri-drivers` |
| Session bus | `dbus-daemon`, `dbus-x11` |

Two deliberate deviations from a trivial package list, both checked against the
Fedora package index rather than guessed:

- **No `xorg-x11-drv-vesa` / `xorg-x11-drv-fbdev`.** Fedora retired both drivers
  in 41 (dead packages, in favour of `simplefb`/KMS). A build that named them
  would fail at `dnf install`. The only X video path left is the server's own
  `modesetting` driver on the `bochs-drm` KMS device, which is why
  `kernel-modules` is installed: `kernel-core` carries no DRM driver, so without
  it there is no `/dev/dri/card0` under v64.
- **`xdpyinfo` and `xprop` are individual packages.** `xorg-x11-utils` no longer
  exists in Fedora. `dbus-x11` (not `dbus-tools`) is where `dbus-launch` lives,
  and the XFCE session script calls it.

## X session (XFCE)

1. `getty@tty1` autologins `lumiboot`; the login shell reads
   `/home/lumiboot/.bash_profile`, which execs `startxfce4` only on `/dev/tty1`
   (`startxfce4` runs `xinit` itself when `DISPLAY` is unset, so there is no
   display manager and no `.xinitrc`). `ttyS0` keeps a plain shell, so `sudo` and
   the smoke test still work while the desktop runs.
2. `/etc/X11/xorg.conf.d/20-lumiboot-modesetting.conf` pins
   `Driver "modesetting"` with `Option "AccelMethod" "none"` (glamor would need
   EGL on a real GPU; a 2D session is enough and cheaper under emulation) and
   sets the AZERTY layout (`XkbLayout fr`, `XkbModel pc105`).
3. `/etc/X11/Xwrapper.config` allows the autologin user to start the server,
   which still needs root rights to open the DRM device.
4. `lumiboot-desktop-ready.service` (`Type=oneshot`, `After=multi-user.target`)
   runs `/usr/local/bin/lumiboot-desktop-ready`: it re-applies the console keymap,
   waits at most 300 s for `/tmp/.X11-unix/X0` **and** for `xdpyinfo` to answer
   **and** for `xfce4-session`/`xfwm4` to run, then prints
   `LUMIBOOT_DESKTOP_READY:fedora-44-x86-64-xfce` to `/dev/ttyS0` and `/dev/tty1`.
   A timeout prints `LUMIBOOT_DESKTOP_START_FAILED:fedora-44-x86-64-xfce` and the
   unit fails: a JavaScript timer or a client-side string is never accepted.

Both readiness units are templates: `@REF@` is substituted by `build.sh` with the
flavor's reference, so no marker can name the other variant. The CLI installs
`lumiboot-ready.service` only; the XFCE flavor installs
`lumiboot-desktop-ready.service` only.

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

Copy the four artifacts into the Git-ignored `apps/web/public/images/<ref>/`:

```bash
# CLI
mkdir -p apps/web/public/images/fedora-44-x86-64
cp images/fedora-44-x86-64/build/{fedora-44-x86-64.iso,vmlinuz,initrd.img,manifest.json} \
  apps/web/public/images/fedora-44-x86-64/

# XFCE
mkdir -p apps/web/public/images/fedora-44-x86-64-xfce
cp images/fedora-44-x86-64/build-xfce/{fedora-44-x86-64-xfce.iso,vmlinuz,initrd.img,manifest.json} \
  apps/web/public/images/fedora-44-x86-64-xfce/
```

Assets are Git-ignored and `manifest.json` is never committed: `write-manifest.mjs`
computes the real sizes and SHA-256 values at build time, and names the ISO after
`IMAGE_REF` (`<ref>.iso`) so one script serves both variants.

## cmdline

```
# CLI
console=tty0 console=ttyS0,115200 root=live:CDLABEL=LUMIBOOT-FEDORA rd.live.image selinux=0 loglevel=4
# XFCE
console=tty0 console=ttyS0,115200 root=live:CDLABEL=LUMIBOOT-FEDORA-XFCE rd.live.image selinux=0 loglevel=4
```

`root=live:CDLABEL=…` selects the ISO by its volume label, `rd.live.image` tells
dmsquash-live to use the `LiveOS/squashfs.img` layout, `selinux=0` avoids an
overlay without labels, `loglevel=4` keeps the serial log readable under
emulation. Guest writes go to the RAM overlay and are lost on stop.

## Smoke test

CLI, on the VGA screen or the COM1 log:

```bash
uname -m                        # x86_64
cat /etc/os-release | head -1   # NAME="Fedora Linux"
id -un                          # lumiboot
sudo -n whoami                  # root
test -f /etc/lumiboot-azerty-ready && echo AZERTY_OK
```

The serial log ends with `LUMIBOOT_GUEST_READY:fedora-44-x86-64`; the same marker
is also written to tty1.

XFCE, in addition:

```bash
ps -eo comm= | grep -x -e Xorg -e xfce4-session -e xfwm4   # both must appear
ls -l /tmp/.X11-unix/X0                                    # the X socket exists
DISPLAY=:0 XAUTHORITY=/home/lumiboot/.Xauthority xdpyinfo | head -3
```

The serial log ends with `LUMIBOOT_DESKTOP_READY:fedora-44-x86-64-xfce`, and the
VGA screen shows the XFCE panel and desktop. A JavaScript timer is never a
successful boot.

## Validation

- CLI: `validated: true` in `packages/catalog/src/profiles.ts`. The real boot is
  proven by `tests/e2e/session-fedora.spec.ts`, which boots the published image in
  Chromium, waits for `LUMIBOOT_GUEST_READY:fedora-44-x86-64` (emitted by
  `lumiboot-ready.service`, never by the client), then types the smoke-test
  commands on ttyS0 and checks their output.
- XFCE: `validated: true` in `packages/catalog/src/profiles.ts` — **an operator
  decision, not a recorded boot**. The ISO was built on
  2026-10-30 under WSL2 (Ubuntu) with `LUMIBOOT_BUILD_DIR` on the WSL
  filesystem (never under `/mnt/c`) and `FLAVOR=xfce`, in ~4 min 06 for
  403 packages: ISO 774 070 272 bytes (738.2 MiB), squashfs 707 444 736 bytes,
  4096 MiB ext4 rootfs, `vmlinuz` 19 024 232 bytes, `initrd.img`
  42 475 004 bytes, volume label `LUMIBOOT-FEDORA-XFCE` verified with
  `xorriso -pvd_info` and `blkid`, disk sha256
  `e8c9b14c293b0e15606b7e169a538a96b959ec23ced30b1288ba4bfbb9e8c0c1`. The four
  artifacts are published under `apps/web/public/images/fedora-44-x86-64-xfce/`,
  and the profile declares the variant launchable. Building is not validating:
  no boot in v64 has printed `LUMIBOOT_DESKTOP_READY:fedora-44-x86-64-xfce` yet,
  so the E2E checklist below stays unchecked until an operator:

  - [ ] boots the published image in Chromium and observes
        `LUMIBOOT_DESKTOP_READY:fedora-44-x86-64-xfce` on the serial console
        **and** the XFCE desktop on the VGA screen;
  - [ ] records that proof (an XFCE Fedora spec under `tests/e2e`, mirroring
        `session-fedora.spec.ts`) and reverts `validated` to `false` if the
        marker never appears. The variant order already matches the default
        (`variantOrder`: 1 for XFCE, 2 for CLI), so nothing else changes.

```bash
VM_E2E_ASSETS=1 pnpm test:e2e tests/e2e/session-fedora.spec.ts
```

The spec skips without the published assets and `apps/web/public/v64/v86.wasm`.
A JavaScript timer or a client-side string is never accepted as a successful
boot.
