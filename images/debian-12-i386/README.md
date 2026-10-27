# Debian 12 i386 images

One script builds three Bookworm variants; all three carry `validated: true` (`packages/catalog/src/profiles.ts`).

| Flavor | Reference | RAM | Disk | Readiness |
|---|---|---:|---:|---|
| `minimal` | `debian-12-i386` | 512 MiB | 3 GiB | `LUMIBOOT_GUEST_READY` |
| `desktop` | `debian-12-i386-desktop` | 1024 MiB | 3 GiB | `LUMIBOOT_DESKTOP_READY` |
| `xfce` | `debian-12-i386-xfce` | 1024 MiB | 4 GiB | `LUMIBOOT_DESKTOP_READY` |

## Build

Linux/WSL2 prerequisites: `debootstrap`, `e2fsprogs`, `util-linux`, `coreutils` (`chroot`, `sha256sum`), `node`, root. Never native Windows.

```bash
sudo ./images/debian-12-i386/build.sh
sudo FLAVOR=desktop ./images/debian-12-i386/build.sh
sudo FLAVOR=xfce ./images/debian-12-i386/build.sh
```

Outputs in `build/`, `build-desktop/` or `build-xfce/`: `rootfs.img`, `vmlinuz-686`, `initrd.img`, `manifest.json`, `packages.tsv`, `provenance.txt`. Variables: `SNAPSHOT=20240101T000000Z`, `DISK_SIZE`, `LUMIBOOT_BUILD_DIR`.

## Publishing

Copy `rootfs.img`, `vmlinuz-686`, `initrd.img` and `manifest.json` into `apps/web/public/images/<ref>/`, ignored by Git. v86 boots `bzimage + initrd + hda`, with no installer; cmdline `console=tty0 console=ttyS0,115200 root=/dev/sda rw`, plus `vga=0x318` on the graphical variants. The exact `cp` commands per flavor are below.

Assets are Git-ignored; `validated: true` requires a valid published manifest and a real boot.

## Validation

- CLI: [`tests/boot-smoke-test.md`](tests/boot-smoke-test.md)
- Openbox: [`tests/desktop-smoke-test.md`](tests/desktop-smoke-test.md)
- XFCE: [`tests/xfce-smoke-test.md`](tests/xfce-smoke-test.md)

After a rebuild: check the manifest SHA-256 values, then rerun the E2E suite with `VM_E2E_ASSETS=1`.

## Desktop (X11 + Openbox)

`debian-12-i386-desktop`: Debian CLI base + Xorg, Openbox, xterm. Published locally, `validated: true`.

| Element | Value |
|---|---|
| RAM / VGA | 1024 MiB / 16 MiB |
| Disk | ext4 RAW, 3 GiB |
| Session | `lumiboot` autologin → `startx` → Openbox + xterm |
| Video | `vga=0x318`, `fbdev` (`modesetting` fallback) on `/dev/fb0` |
| Readiness | `LUMIBOOT_DESKTOP_READY:debian-12-i386-desktop` |

The marker needs a live X socket, `xdpyinfo` and `openbox`; otherwise the guest emits `LUMIBOOT_DESKTOP_START_FAILED`. `LUMIBOOT_GUEST_READY` only attests `multi-user.target`. Xorg runs through the setuid `Xorg.wrap` (`needs_root_rights=yes`) inside an unprivileged session; guest script 300 s, profile 240 s.

### Build and publish

Linux/WSL2 with root, never native Windows: `debootstrap`, `e2fsprogs`, `util-linux`, `node`.

```bash
sudo FLAVOR=desktop ./images/debian-12-i386/build.sh
mkdir -p apps/web/public/images/debian-12-i386-desktop
cp images/debian-12-i386/build-desktop/{rootfs.img,vmlinuz-686,initrd.img,manifest.json} \
  apps/web/public/images/debian-12-i386-desktop/
```

`build-desktop/` also holds `packages.tsv` and `provenance.txt`. Overrides: `SNAPSHOT`, `DISK_SIZE`, `LUMIBOOT_BUILD_DIR`.

### Validation

[`tests/desktop-smoke-test.md`](tests/desktop-smoke-test.md) after a rebuild, then:

```bash
VM_E2E_ASSETS=1 pnpm test:e2e --grep "Desktop"
```

## XFCE

`debian-12-i386-xfce`: Debian/Xorg base + full XFCE session. Published locally, `validated: true`.

| Element | Value |
|---|---|
| RAM / VGA | 1024 MiB / 16 MiB |
| Disk | ext4 RAW, 4 GiB |
| Session | `lumiboot` autologin → `startx` → `startxfce4` |
| Video | X configuration shared with Openbox, `vga=0x318` |
| Readiness | `LUMIBOOT_DESKTOP_READY:debian-12-i386-xfce` |

The marker needs a live X socket, `xdpyinfo` and `xfce4-session` or `xfwm4`; otherwise the guest emits `LUMIBOOT_DESKTOP_START_FAILED`. Guest script 300 s, profile 240 s.

### Build and publish

Linux/WSL2 with root; prerequisites identical to the `desktop` flavor.

```bash
sudo FLAVOR=xfce ./images/debian-12-i386/build.sh
mkdir -p apps/web/public/images/debian-12-i386-xfce
cp images/debian-12-i386/build-xfce/{rootfs.img,vmlinuz-686,initrd.img,manifest.json} \
  apps/web/public/images/debian-12-i386-xfce/
```

`build-xfce/` also holds `packages.tsv` and `provenance.txt`. Overrides: `SNAPSHOT`, `DISK_SIZE`, `LUMIBOOT_BUILD_DIR`.

### Validation

[`tests/xfce-smoke-test.md`](tests/xfce-smoke-test.md) after a rebuild, then:

```bash
VM_E2E_ASSETS=1 pnpm test:e2e --grep "XFCE"
```
