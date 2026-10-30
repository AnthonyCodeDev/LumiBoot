# Alpine Linux 3.24 x86-64 for v64

Two flavors, two pipelines:

| Flavor | Reference | Session | RAM | Media | Marker |
|---|---|---|---:|---|---|
| CLI | `alpine-3-24-x86-64` | `lumiboot` autologin on tty1 and ttyS0, text console | 1024 MiB | official 3.24.0 `virt` ISO, unmodified | `lumiboot@lumiboot` |
| XFCE (default card variant) | `alpine-3-24-x86-64-xfce` | Xorg + XFCE on tty1, text shell on ttyS0 | 2048 MiB | official 3.24.3 ISO rebuilt with a preinstalled squashfs rootfs | `LUMIBOOT_DESKTOP_READY` |

## CLI: official ISO + apkovl overlay

`pnpm assets:v64:alpine` downloads the official unmodified Alpine 3.24.0 `virt`
ISO, verifies the SHA-256 used by v64's own x86-64 tests, extracts its kernel and
initramfs, and publishes the three files plus a checked manifest in
`apps/web/public/images/alpine-3-24-x86-64/`. The initramfs is patched with an
`apkovl` overlay that adds the autologin scripts, the French AZERTY console map
and the OpenRC runlevels; the ISO itself is copied as is.

The ISO and extracted binaries are build assets and are not committed. The guest
boots entirely in the browser. `localhost login:` on COM1 is the boot proof; a
JavaScript timer is never treated as a successful boot.

Runtime revision: `speedyHKjournalist/v64@74d2bafcc7d568e2ab4374804e176f1a8a350f61`.

## XFCE: `build.sh`, squashfs rootfs and a custom init

```bash
FLAVOR=xfce ./images/alpine-3-24-x86-64/build.sh
pnpm assets:v64:alpine:xfce
```

Outputs land in `build-xfce/`: `alpine-3-24-x86-64-xfce.iso`,
`boot/lumiboot-rootfs.squashfs`, `vmlinuz-virt`, `initramfs-virt`,
`packages.tsv` and `provenance.txt`. `pnpm assets:v64:alpine:xfce` publishes the
ISO, the kernel and the initramfs (the rootfs squashfs is already inside the
ISO) under `apps/web/public/images/alpine-3-24-x86-64-xfce/` and recomputes the
manifest from the real files. That output directory is Git-ignored.

### Why not the official boot path

The Alpine `virt` ISO carries **no rootfs**. Its initramfs installs one into a
tmpfs with `apk add` from the ISO's `/apks` repository on every boot. That is
fine for a console, but XFCE needs ~370 packages and ~650 MiB unpacked
(10–20 min under v64). The XFCE flavor therefore ships:

- a **preinstalled squashfs rootfs** (`boot/lumiboot-rootfs.squashfs`), built by
  `apk.static --root` and packed with `mksquashfs -comp xz -b 131072 -all-root`
  (root-owned files and the setuid bit of `usr/libexec/Xorg.wrap`);
- a **custom initramfs `init`** (`guest/init`) that mounts the ISO and the rootfs
  squashfs read-only, loads overlayfs from the modules already inside that rootfs,
  mounts a tmpfs for the **overlayfs RAM upper layer**, then `switch_root`s to
  OpenRC. Guest writes stay in memory and are lost on stop, like every other
  image;
- a **repacked official ISO**: `xorriso -boot_image any keep` keeps the BIOS and
  UEFI El-Torito records and `/apks` is removed (~15 MiB). LumiBoot boots the
  disc through v64's `bzimage + initrd + cdrom` path, like the CLI flavor.

The kernel and its modules are the official ones: `vmlinuz-virt` plus the whole
`boot/modloop-virt` tree extracted into `lib/modules/<version>/`.

### Prerequisites

Linux or WSL2 on an x86_64 host, **no root commands at all**, and `curl`,
`xorriso`, `squashfs-tools` (`mksquashfs`, `unsquashfs`), `cpio`, `gzip`, `tar`,
`sha256sum`. The work directory defaults to
`${XDG_CACHE_HOME:-$HOME/.cache}/lumiboot/alpine-3-24-x86-64` and can be moved
with `LUMIBOOT_BUILD_DIR`; it must be a native Linux filesystem (`ext4`), never
`/mnt/c` under WSL2: DrvFs drops file modes and the setuid bit.

Downloads are pinned and cached: the ISO by SHA-256
`cdc1bc0efc64d8d611bf3733f54868172a545888dfd726f518bf279bcb0ff1af`,
`apk-tools-static 3.0.8-r0` and `alpine-keys 2.6-r0` by SHA-256 (recorded in
`provenance.txt`). Packages are **signature-checked** against that keyring, never
installed with `--allow-untrusted`.

### Packages

`alpine-base`, `doas`, `kbd-bkeymaps`, `eudev`, `udev-init-scripts-openrc`,
`eudev-openrc`, `dbus`, `dbus-openrc`, `xorg-server`, `xinit`,
`xf86-input-libinput`, `xf86-video-fbdev`, `xfce4`, `xfce4-terminal`,
`xdpyinfo`, `xsetroot`, `setxkbmap`, `font-dejavu`.

Two deliberate notes:

- `xfce4` pulls the session, panel, WM and settings but **not** `xorg-server`,
  `xinit`, `xfce4-terminal` or `xdpyinfo`: those are listed explicitly.
- `xf86-input-keyboard` and `xf86-input-mouse` no longer exist in 3.24. Input
  goes through `xf86-input-libinput` + `eudev`, which is also why `mdev` is
  replaced by `udev` in the runlevels: libinput and Xorg discover `/dev/input`
  and `/dev/dri` through udev tags.
- `xfce4` pulls `tumbler → libgepub → webkit2gtk` (~200 MiB) and `xorg-server`
  pulls `mesa`/`llvm22-libs` (~235 MiB). The dependencies are kept: the squashfs
  compresses them, and trimming them would silently change the desktop.

### X session

1. `getty` autologins `lumiboot` on tty1; the login shell reads
   `/home/lumiboot/.profile`, which on `/dev/tty1` starts
   `lumiboot-desktop-ready` in the background (`doas -n`: the probe needs root to
   write to the root/dialout-owned `/dev/ttyS0`) and execs `lumiboot-startx`.
2. `lumiboot-startx` tries `startx -- :0 vt1 -nolisten tcp -layout
   LumiBootModesetting` first (udev loads `bochs.ko`, so the KMS device exists
   before X), then `LumiBootFBDev` as the fallback. Both layouts live in
   `/etc/X11/xorg.conf.d/20-lumiboot.conf`, with a `fr`/`pc105` libinput
   keyboard class.
3. `lumiboot-desktop-ready` waits at most 600 s for `/tmp/.X11-unix/X0`, for
   `xdpyinfo` and for `xfce4-session`/`xfwm4`, then prints
   `LUMIBOOT_DESKTOP_READY:alpine-3-24-x86-64-xfce` to `/dev/ttyS0`. On timeout
   it prints `LUMIBOOT_DESKTOP_START_FAILED:…` and fails.
4. `lumiboot-setup` (inittab `sysinit`, before OpenRC) recreates the account,
   its groups and the AZERTY console keymap on every boot, because the rootfs is
   read-only and identical at each start.

## Smoke test

Checklist: [`tests/xfce-smoke-test.md`](tests/xfce-smoke-test.md). CLI commands
are in [`../docs/systems.md`](../../docs/systems.md#alpine-linux-324-x86-64).

## Validation

Measured on 2026-10-30 under WSL2 (Ubuntu) with `LUMIBOOT_BUILD_DIR` on the WSL
filesystem, then in Chromium on the Playwright port 5200:

| Step | Result |
|---|---|
| Build (`FLAVOR=xfce ./images/alpine-3-24-x86-64/build.sh`) | 1 min 44.6 s, 373 packages |
| Rootfs squashfs | 249 782 272 bytes (238.2 MiB), from an 817 MB rootfs directory |
| ISO | 305 135 616 bytes (291.0 MiB), sha256 `c2a6cba9968de2f9447569d69794310e93ac5b0e8dabf76a7c4d710aabf097ee` |
| Kernel / initramfs | 12 641 280 B / 9 866 400 B |
| `LUMIBOOT_DESKTOP_READY:alpine-3-24-x86-64-xfce` | 132.7 s after the start click |
| VGA canvas | 1024x768, mean luminance 58.8/255, 99.6 % non-black, 217 colours, three stable samples |
| E2E spec | `tests/e2e/desktop-alpine-xfce.spec.ts`, 1 passed (5.8 min) |

The spec also asserts the session reaches `running` only after the marker, that
no `login:` prompt is left on the VGA screen, and that the lifecycle stops
cleanly. The manual items of the checklist (userspace commands, setxkbmap,
second boot) are not covered by the spec and stay to be run by hand.

Building is still not validating: revert `validated` to `false` as soon as a
rebuild stops reaching the marker or stops drawing the desktop.
