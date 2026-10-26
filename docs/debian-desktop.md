# Debian 12 X11/Openbox

`debian-12-i386-desktop`: Debian CLI base + Xorg, Openbox, xterm. Published locally, `validated: true`.

## Profile

| Element | Value |
|---|---|
| RAM / VGA | 1024 MiB / 16 MiB |
| Disk | ext4 RAW, 3 GiB |
| Session | `lumiboot` autologin → `startx` → Openbox + xterm |
| Video | `vga=0x318`, `fbdev` (`modesetting` fallback) on `/dev/fb0` |
| Readiness | `LUMIBOOT_DESKTOP_READY:debian-12-i386-desktop` |

Marker emitted once the X socket, `xdpyinfo` and `openbox` are alive, otherwise `LUMIBOOT_DESKTOP_START_FAILED`; `LUMIBOOT_GUEST_READY` only attests `multi-user.target`. Xorg runs under setuid `Xorg.wrap` (`needs_root_rights=yes`), unprivileged session; guest script 300 s, profile 240 s.

## Build and publish

Linux/WSL2 + root (never native Windows): `debootstrap`, `e2fsprogs`, `util-linux`, `node`.

```bash
sudo FLAVOR=desktop ./images/debian-12-i386/build.sh
mkdir -p apps/web/public/images/debian-12-i386-desktop
cp images/debian-12-i386/build-desktop/{rootfs.img,vmlinuz-686,initrd.img,manifest.json} \
  apps/web/public/images/debian-12-i386-desktop/
```

`build-desktop/` also contains `packages.tsv` and `provenance.txt`; overrides `SNAPSHOT`, `DISK_SIZE`, `LUMIBOOT_BUILD_DIR`.

## Validation

[`desktop-smoke-test.md`](../images/debian-12-i386/tests/desktop-smoke-test.md) after a rebuild, then:

```bash
VM_E2E_ASSETS=1 pnpm test:e2e --grep "Desktop"
```

Assets ignored by Git; `validated: true` only if the published manifest and a real boot are valid.
