# Systems

| Reference                | Variant                        | Guest RAM | Media               | Readiness                |
| ------------------------ | ------------------------------ | --------- | ------------------- | ------------------------ |
| `debian-12-i386`         | Debian 12 CLI                  | 512 MiB   | built rootfs        | `LUMIBOOT_GUEST_READY`   |
| `debian-12-i386-desktop` | Debian 12 X11/Openbox          | 1024 MiB  | built rootfs        | `LUMIBOOT_DESKTOP_READY` |
| `debian-12-i386-xfce`    | Debian 12 XFCE                 | 1024 MiB  | built rootfs        | `LUMIBOOT_DESKTOP_READY` |
| `ubuntu-18-i386`         | Ubuntu 18.04 CLI               | 512 MiB   | built rootfs        | `LUMIBOOT_GUEST_READY`   |
| `ubuntu-18-i386-desktop` | Ubuntu 18.04 X11/Openbox       | 1024 MiB  | built rootfs        | `LUMIBOOT_DESKTOP_READY` |
| `ubuntu-18-i386-xfce`    | Ubuntu 18.04 XFCE              | 1024 MiB  | built rootfs        | `LUMIBOOT_DESKTOP_READY` |
| `fedora-44-x86-64`       | Fedora 44 x86-64 CLI           | 1024 MiB  | built bootable ISO  | `LUMIBOOT_GUEST_READY`   |
| `fedora-44-x86-64-xfce`  | Fedora 44 x86-64 XFCE          | 2048 MiB  | built bootable ISO  | `LUMIBOOT_DESKTOP_READY` |
| `alpine-3-24-x86-64`     | Alpine 3.24 x86-64 CLI (v64 JIT) | 1024 MiB  | official virt ISO   | `lumiboot@lumiboot`      |
| `alpine-3-24-x86-64-xfce` | Alpine 3.24 x86-64 XFCE | 2048 MiB  | rebuilt virt ISO + squashfs rootfs | `LUMIBOOT_DESKTOP_READY` |
| `windows-7-pro-sp1-x86`  | Windows 7 Professional SP1 x86 | 1536 MiB  | operator RAW disk   | `disk-boot`              |
| `windows-7-x86`          | Windows 7 Lite x86             | 1024 MiB  | operator RAW disk   | `disk-boot`              |
| `windows-8-1-x86`        | Windows 8.1 Pro x86 32-bit     | 2048 MiB  | operator RAW disk   | `disk-boot`              |
| `windows-10-x86`         | Windows 10 x86 32-bit          | 2048 MiB  | operator RAW disk   | `disk-boot`              |
| `custom-image`           | Custom image (ISO / IMG / RAW) | 512 MiB   | user-imported media | `LUMIBOOT_GUEST_READY`   |

No disk, ISO or license key is shipped by this repository. This page is the index and the commands; details live next to each image under `images/<ref>/`.

Windows 11 and macOS are catalogued but not developed: their x86-64 or ARM engine is not integrated, so they stay `planned` ("Not ready") with nothing to import.

Ubuntu 18.04 LTS follows the Debian pipeline — one script, three variants — and all three are built
locally, published into the Git-ignored `apps/web/public/images/<ref>/` directories and validated by
a real boot (`validated: true`, availability `ready`), with XFCE as the default variant. Nothing is
distributed here: rebuild the media from
[`images/ubuntu-18-i386/README.md`](../images/ubuntu-18-i386/README.md); see
[Ubuntu 18.04 LTS](#ubuntu-1804-lts).

## Debian 12

Prerequisites: `debootstrap`, `e2fsprogs`, `util-linux`, `coreutils`, `node`, root, Linux or WSL2.

```bash
sudo ./images/debian-12-i386/build.sh                 # CLI
sudo FLAVOR=desktop ./images/debian-12-i386/build.sh  # X11 + Openbox
sudo FLAVOR=xfce ./images/debian-12-i386/build.sh     # XFCE
```

Outputs land in `build/`, `build-desktop/` and `build-xfce/`. Copy `rootfs.img`, `vmlinuz-686`, `initrd.img` and `manifest.json` into `apps/web/public/images/<ref>/`. `<ref>` is `debian-12-i386`, `debian-12-i386-desktop` or `debian-12-i386-xfce`.

Build details, package lists, profile measurements and smoke tests: [`images/debian-12-i386/README.md`](../images/debian-12-i386/README.md).

## Ubuntu 18.04 LTS

Prerequisites: Linux or WSL2, root, `debootstrap` (with its `bionic` script), `e2fsprogs`, `util-linux`, `coreutils`, `node`.

```bash
sudo ./images/ubuntu-18-i386/build.sh                 # CLI
sudo FLAVOR=desktop ./images/ubuntu-18-i386/build.sh  # X11 + Openbox
sudo FLAVOR=xfce ./images/ubuntu-18-i386/build.sh     # XFCE
```

| Flavor | Reference | RAM | Disk |
|---|---|---:|---:|
| CLI | `ubuntu-18-i386` | 512 MiB | 3 GiB |
| X11 + Openbox | `ubuntu-18-i386-desktop` | 1024 MiB | 3 GiB |
| XFCE | `ubuntu-18-i386-xfce` | 1024 MiB | 4 GiB |

Outputs land in `build/`, `build-desktop/` and `build-xfce/`: `rootfs.img`, `vmlinuz-686`, `initrd.img`, `manifest.json`, `packages.tsv` and `provenance.txt`. Copy the first four into `apps/web/public/images/<ref>/`, a Git-ignored directory. v86 boots `bzimage + initrd + hda`, with no installer; the cmdline is `console=tty0 console=ttyS0,115200 root=/dev/sda rw rootwait rootdelay=5`, plus `vga=0x318` on the graphical variants, and all three manifests carry it as `boot.cmdline`.

`rootwait rootdelay=5` is required, not decorative: v86 serves the disk over asynchronous HTTP Range requests, so `/dev/sda` may answer after the ATA probe. Without it the bionic initramfs (systemd 237) abandons the first probe and drops to a shell (`Gave up waiting for root file system device … ALERT! /dev/sda does not exist`) even though the kernel booted. Debian tolerates the race, Ubuntu does not.

The bionic 4.15 kernel names the DRM driver `bochs_drm` (renamed `bochs` in 4.20+), so `guest/no-drm.conf` blacklists both names for the CLI variant, which must keep the text VGA console; the graphical variants keep `bochs_drm`, the only `/dev/fb0` provider under v86.

18.04 "bionic" is the **last Ubuntu release with an i386 port**, and it is end-of-life (ESM). `archive.ubuntu.com` and `security.ubuntu.com` still serve it, i386 included, and they are the script's defaults. If the archive stops serving bionic, point `UBUNTU_MIRROR` and `UBUNTU_SECURITY_MIRROR` at `http://old-releases.ubuntu.com/ubuntu`. `SNAPSHOT`, `DISK_SIZE`, `LUMIBOOT_BUILD_DIR` and `UBUNTU_KEYRING` are supported.

The bionic keyring is often missing (a Debian host, or a current `ubuntu-keyring`): pass `UBUNTU_KEYRING=/usr/share/keyrings/ubuntu-archive-keyring.gpg`, otherwise `debootstrap` runs with `--no-check-gpg` and says so; `provenance.txt` records the mode.

A successful build is not a proof: the order is build → publish → smoke test (`images/ubuntu-18-i386/tests/*.md`) → `validated: true` in `packages/catalog/src/profiles.ts` → `VM_E2E_ASSETS=1 pnpm test:e2e --grep "Ubuntu"`. All three variants went through it. Measured real boots: CLI about 2 min 30 (booted twice per run: first boot and restart), X11/Openbox 3 min 27, XFCE 4 min 04; `uname -a` reports `4.15.0-213-generic i686`, `/etc/os-release` says Ubuntu 18.04 LTS, `sudo -n whoami` returns `root`, and autologin works on both VGA and serial; `session-ubuntu.spec.ts`, `desktop-ubuntu.spec.ts` and `xfce-ubuntu.spec.ts` pass with `VM_E2E_ASSETS=1`. Keep that order as the maintenance rule: revert the flag as soon as a rebuild or a boot stops matching the smoke test.

Build details, packages, provenance and smoke tests: [`images/ubuntu-18-i386/README.md`](../images/ubuntu-18-i386/README.md).

Readiness threshold: the CLI profile waits 240 s for `LUMIBOOT_GUEST_READY`, like the graphical variants, because software emulation can push a measured boot past 120 s. Expiry is diagnostic only (`boot-timeout`): the VM is not stopped, the console stays live and a late marker still reaches `running`.

## Fedora 44 x86-64

Prerequisites: Linux or WSL2 on an x86_64 host, root, `dnf`, `rpm`, `dracut`,
`squashfs-tools`, `e2fsprogs`, `xorriso`, `grub-mkrescue` (`grub-common`,
`grub-pc-bin`, `mtools`), `cpio`, `xz`, `node`, and the Fedora 44 GPG key
(`/etc/pki/rpm-gpg/RPM-GPG-KEY-fedora-44-primary`).

```bash
sudo ./images/fedora-44-x86-64/build.sh                 # CLI
sudo FLAVOR=xfce ./images/fedora-44-x86-64/build.sh     # Xorg + XFCE
```

| Flavor | Reference | RAM | Disk | Marker |
|---|---|---:|---:|---|
| CLI | `fedora-44-x86-64` | 1024 MiB | 2 GiB | `LUMIBOOT_GUEST_READY` |
| XFCE | `fedora-44-x86-64-xfce` | 2048 MiB | 4 GiB | `LUMIBOOT_DESKTOP_READY` |

Outputs land in `build/` and `build-xfce/`: `vmlinuz`, `initrd.img`, `<ref>.iso`,
`manifest.json`, `packages.tsv`, `provenance.txt`. Copy the first four into
`apps/web/public/images/<ref>/`, a Git-ignored directory. The script builds a
rootfs with `dnf --installroot` and packs it as an ext4 image inside
`LiveOS/squashfs.img`. v64 mounts the ISO as a `cdrom` and nothing else: the disc
carries its own GRUB El-Torito boot record, `vmlinuz`, `initrd.img` and a
`grub.cfg` with
`console=tty0 console=ttyS0,115200 root=live:CDLABEL=<ISO label> rd.live.image selinux=0 loglevel=4`
(`LUMIBOOT-FEDORA` for the CLI, `LUMIBOOT-FEDORA-XFCE` for XFCE: the label is the
only way the initramfs finds its medium), and its manifest says
`boot.cdromOnly: true`.

El-Torito is the boot path for a reason, not a preference. When v64 injects a
`bzimage`, `libv86.mjs` hard-codes the initrd window at 64 MiB; the Fedora 44
kernel decompresses to ~74 MiB and overwrote the initrd mid-boot
(`Initramfs unpacking failed: junk within compressed archive`, then
`Kernel panic - not syncing: VFS: Unable to mount root fs on unknown-block(0,0)`).
32-bit Debian/Ubuntu kernels stay below that limit, Fedora does not, and v86
exposes no `initrd_addr` option. Letting the disc's bootloader place kernel and
initramfs removes the constraint.

The CLI flavor is `validated: true`: `tests/e2e/session-fedora.spec.ts` boots the
published image in Chromium, waits for `LUMIBOOT_GUEST_READY:fedora-44-x86-64`
(emitted by the guest, never by the client), types the smoke-test commands on
ttyS0 and checks their output. A successful build alone proves nothing: revert
the flag as soon as a rebuild stops reaching the marker.

The XFCE flavor is `validated: true` too, and now on measured evidence: the
pipeline (Xorg `modesetting` on the bochs-drm framebuffer, `startxfce4` from the
tty1 autologin, `lumiboot-desktop-ready.service` waiting for the X socket,
`xdpyinfo` and the session process before emitting
`LUMIBOOT_DESKTOP_READY:fedora-44-x86-64-xfce`) was booted in Chromium on
2026-10-30: the guest printed the marker and the desktop appeared on the VGA
canvas in 1024x768. Fedora 41+ retired `xorg-x11-drv-vesa` and
`xorg-x11-drv-fbdev`, so `kernel-modules` (bochs-drm) and the server's own
`modesetting` driver are the only video path. XFCE is the default variant of the
card (`variantOrder: 1`), as on Debian and Ubuntu; the CLI comes second
(`variantOrder: 2`). Both variants are launchable once their artifacts are
published under `apps/web/public/images/<ref>/`.

The graphics adapter is a v64 `extra` option (`v64Graphics`, applied by
`V64Provider` from the profile when the application passes no override). Three
adapters were probed on the same guest with the same ISO, on the Playwright port
5200: `bochs_vga` (kept) and `virtio_gpu` both paint the XFCE desktop (mean
luminance 172/255, 99.8 % non-black pixels at 1024x768), while `vmware_svga`
leaves the canvas in the SeaBIOS text mode: `vmwgfx` moves the session to the
VMware SVGA device, which v64 can only present through its WebGPU renderer
(absent in headless Chromium: `No available adapters.`). One trap for anyone
probing this screen: the canvas is legitimately black for ~4 minutes after
`LUMIBOOT_DESKTOP_READY`, until `xfdesktop` paints the root window, so a probe
that stops at the marker measures the wallpaper, not a rendering failure.

`tests/e2e/desktop-fedora-xfce.spec.ts` records that proof: it boots the
published ISO, waits for the guest marker, then polls the canvas until it is
actually drawn and requires three consecutive stable measurements. It skips
without `VM_E2E_ASSETS=1` and the published `manifest.json`.

Build details, package lists and smoke tests:
[`images/fedora-44-x86-64/README.md`](../images/fedora-44-x86-64/README.md).

## Alpine Linux 3.24 x86-64

Two flavors with two different pipelines:

| Flavor | Reference | RAM | Media | Marker |
|---|---|---:|---|---|
| CLI | `alpine-3-24-x86-64` | 1024 MiB | official 3.24.0 `virt` ISO, kernel + initramfs | `lumiboot@lumiboot` |
| XFCE | `alpine-3-24-x86-64-xfce` | 2048 MiB | official 3.24.3 ISO rebuilt with a preinstalled squashfs rootfs | `LUMIBOOT_DESKTOP_READY` |

The CLI flavor is only published: `pnpm assets:v64:alpine` downloads the
official unmodified ISO, verifies its pinned SHA-256, extracts the kernel and the
initramfs and writes the apkovl overlay that adds the LumiBoot autologin.

The XFCE flavor is rebuilt locally, because the official `virt` ISO carries **no
rootfs**: its initramfs installs one into a tmpfs with `apk add` from the ISO's
`/apks` repository at every boot. That is cheap for a console, but XFCE means
~370 packages and ~650 MiB to unpack on each start (10–20 min under v64).
The variant therefore ships a **preinstalled squashfs rootfs** mounted read-only
with an **overlayfs RAM upper layer** by a custom initramfs `init`
(`images/alpine-3-24-x86-64/guest/init`): it mounts the ISO and the rootfs
squashfs, loads overlayfs from the modules already inside that rootfs, mounts a
tmpfs for the overlay, moves `/proc /sys /dev` and `switch_root`s to OpenRC.
Guest writes stay in RAM and are lost on stop, like every other LumiBoot image.

Prerequisites: Linux or WSL2 on an x86_64 host, **no root at all**, `curl`,
`xorriso`, `squashfs-tools` (`mksquashfs`, `unsquashfs`), `cpio`, `gzip`, `tar`
and `sha256sum`. The work directory (default
`${XDG_CACHE_HOME:-$HOME/.cache}/lumiboot/alpine-3-24-x86-64`, overridable with
`LUMIBOOT_BUILD_DIR`) must be a native Linux filesystem: `/mnt/c` under WSL2
drops file modes and the setuid bit of `usr/libexec/Xorg.wrap`.

```bash
FLAVOR=xfce ./images/alpine-3-24-x86-64/build.sh
pnpm assets:v64:alpine:xfce
```

`build.sh` installs the rootfs with `apk.static --root` (signature-checked
against the pinned Alpine keyring, no `--allow-untrusted`, no chroot), drops the
kernel modules of `boot/modloop-virt` into `lib/modules`, installs the guest
files, wires the OpenRC runlevels with plain symlinks, packs the rootfs with
`mksquashfs -all-root` (which keeps the setuid bit of `usr/libexec/Xorg.wrap`),
rebuilds the initramfs around its own `init`, and repacks the ISO with `xorriso
-boot_image any keep`: the official BIOS and UEFI El-Torito records are kept and
`/apks` is removed. Outputs land in `images/alpine-3-24-x86-64/build-xfce/`;
`pnpm assets:v64:alpine:xfce` publishes them under
`apps/web/public/images/alpine-3-24-x86-64-xfce/` and recomputes the manifest
(on v64 the guest boots `bzimage + initrd + cdrom`, like the CLI flavor).

The XFCE profile is `validated: true`: `tests/e2e/desktop-alpine-xfce.spec.ts`
booted the published image in Chromium on 2026-10-30 and the guest printed
`LUMIBOOT_DESKTOP_READY:alpine-3-24-x86-64-xfce` 132.7 s after the start click;
the desktop was then painted on the VGA canvas in 1024x768 (mean luminance
58.8/255, 99.6 % non-black pixels, 217 distinct colours over three stable
samples). Builds and sizes are measured too: the ISO is 305 135 616 bytes, the
rootfs squashfs 249 782 272 bytes for 373 packages, and a full build takes about
1 min 45 s under WSL2. As everywhere: revert the flag as soon as a rebuild stops
reaching the marker.

Build details, package list and smoke test:
[`images/alpine-3-24-x86-64/README.md`](../images/alpine-3-24-x86-64/README.md).

## Windows 7

Requires an installed 32-bit RAW disk, bootable in BIOS/MBR, with your own license; a UEFI/GPT installation does not boot. Place it at `images/windows-7-pro-sp1-x86/disk.img`:

```bash
pnpm assets:windows7:prepare --source images/windows-7-pro-sp1-x86/disk.img --ref windows-7-pro-sp1-x86 --display-name "Windows 7 Professional SP1 x86" --architecture i386 --memory-mib 1536 --vga-mib 16 --out images/windows-7-pro-sp1-x86
pnpm assets:windows7:check
```

The Lite variant reads `images/windows-7-x86/disk.img` with 1024 MiB of guest RAM. Register it with `--ref windows-7-x86 --memory-mib 1024`.

Guest networking needs an NE2000 driver installed inside the disk, offline under QEMU. Disk preparation, driver install, readiness, HTTP Range transport and network modes: [`images/windows-7-pro-sp1-x86/README.md`](../images/windows-7-pro-sp1-x86/README.md). The Lite variant has its own page: [`images/windows-7-x86/README.md`](../images/windows-7-x86/README.md).

## Windows 8.1 Pro x86

Requires a 32-bit BIOS/MBR installation; a UEFI/GPT disk does not boot. Convert to RAW, keep it outside `public/`:

```powershell
qemu-img convert -O raw source.qcow2 images/windows-8-1-x86/disk.img
pnpm assets:windows8:prepare --source images/windows-8-1-x86/disk.img
pnpm assets:windows8:check
```

2048 MiB of guest RAM minimum. The profile declares `e1000` + ACPI, matching a disk installed with `-nic user,model=e1000`. QEMU install, RAW conversion, HTTP Range and limitations: [`images/windows-8-1-x86/README.md`](../images/windows-8-1-x86/README.md).

The profile declares `validated: true` because the session boots from the operator's installed RAW disk: availability is `ready` and the card is launchable. No Windows 8.1 E2E spec is versioned under `tests/e2e`, so this is an explicit operator decision rather than a recorded test proof. See [`images/windows-8-1-x86/README.md`](../images/windows-8-1-x86/README.md#validation-status) for the honest validation checklist.

## Windows 10 x86

Requires a 32-bit BIOS/MBR installation; a UEFI/GPT disk does not boot. Convert to RAW, keep it outside `public/`:

```powershell
qemu-img convert -O raw source.qcow2 images/windows-10-x86/disk.img
pnpm assets:windows10:prepare --source images/windows-10-x86/disk.img
pnpm assets:windows10:check
```

2048 MiB of guest RAM minimum. The virtio-net driver must already be in the disk. QEMU install, VirtualBox conversion and validation: [`images/windows-10-x86/README.md`](../images/windows-10-x86/README.md).

## Custom image

Generic entry point: boot any 32-bit disk media you own with the integrated v86 engine.

- Accepted formats: `.iso`, `.img`, `.raw`. A `.img`/`.raw` boots as a hard disk (`hda`); a bootable (live) `.iso` is mounted as a CD-ROM and boots from it (CD-first boot order). Installation ISOs are not supported: v86 persists no write, so run a media that is already bootable.
- The media is imported through the page's import card and stored as a local blob in the browser; it is never uploaded, and LumiBoot distributes no image.
- 512 MiB of guest RAM, no fixed boot device (the media format decides the mount), `LUMIBOOT_GUEST_READY:custom-image` marker.
- Availability stays `resource-required` ("Resource required") until a media is imported.
- You must hold a licence for the software contained in the media; the security of that disk is yours.

## Variant order

One card per family; the selector picks the launched profile.

Fields in `packages/catalog/src/profiles.ts`, copied into `OSDefinition` by `systems.ts`:

| Field | Role |
|---|---|
| `variantGroupId` | parent id; absent on the parent |
| `variantName` | short selector label |
| `variantOrder` | ascending priority; lowest = default; absent = after the ordered variants |
| `displayMode` | `text` for a CLI guest; `graphical` (or absent) for a VGA/framebuffer guest |

Each variant has its own image, profile, readiness and availability.

`displayMode` is explicit, never inferred from the display name: `text` identifies a CLI guest and `graphical` a VGA/framebuffer guest. The guest screen is always the primary surface and serial logs start collapsed for every profile; the "Logs" button explicitly shows or hides them.

Current groups:

| Group | Order | Default |
|---|---|---|
| Debian (`debian-12-i386`) | XFCE, X11, CLI | XFCE |
| Ubuntu (`ubuntu-18-i386`) | XFCE, X11, CLI | XFCE |
| Fedora 44 (`fedora-44-x86-64`) | XFCE, CLI | XFCE (both variants `validated: true`; both ISOs are built, published and booted in CI-less Playwright runs) |
| Alpine 3.24 (`alpine-3-24-x86-64`) | XFCE, CLI | XFCE (both variants `validated: true`; the XFCE ISO is built, published and booted for real) |
| Windows 7 (`windows-7-x86`) | Professional, Lite | Professional |

Helpers in `packages/catalog/src/systems.ts`: `getDisplaySystems()` returns the parents and standalone systems, `getVariantGroup()` the members sorted by `variantOrder`, `getDefaultVariant()` the first member, `getVariantParent()` and `getVariantParentId()` resolve the parent, and `hasVariants()` tells whether a group holds several entries.

Adding one: the image in `images.ts`, the profile in `profiles.ts`, then `variantGroupId`, `variantName`, `variantOrder` and the catalogue/UI/E2E tests. No React component to change.

## Availability

`ready` requires a present image, a compatible profile, an integrated engine and `validated: true`. Without them the card is listed as unavailable.

## Limits

Disks are mounted read-only: guest writes stay in memory and are lost on stop. Software emulation makes boot slow. The license and the security of the disk are the operator's responsibility.
