# Debian 12 XFCE

`debian-12-i386-xfce`: Debian/Xorg base + full XFCE session. Published locally, `validated: true`.

## Profile

| Element | Value |
|---|---|
| RAM / VGA | 1024 MiB / 16 MiB |
| Disk | ext4 RAW, 4 GiB |
| Session | `lumiboot` autologin → `startx` → `startxfce4` |
| Video | X configuration shared with Openbox, `vga=0x318` |
| Readiness | `LUMIBOOT_DESKTOP_READY:debian-12-i386-xfce` |

Marker emitted once the X socket, `xdpyinfo` and `xfce4-session` or `xfwm4` are running, otherwise `LUMIBOOT_DESKTOP_START_FAILED`; guest script 300 s, profile 240 s.

## Build and publish

Linux/WSL2 + root, prerequisites identical to the `desktop` flavor.

```bash
sudo FLAVOR=xfce ./images/debian-12-i386/build.sh
mkdir -p apps/web/public/images/debian-12-i386-xfce
cp images/debian-12-i386/build-xfce/{rootfs.img,vmlinuz-686,initrd.img,manifest.json} \
  apps/web/public/images/debian-12-i386-xfce/
```

`build-xfce/` also contains `packages.tsv` and `provenance.txt`; overrides `SNAPSHOT`, `DISK_SIZE`, `LUMIBOOT_BUILD_DIR`.

## Validation

[`xfce-smoke-test.md`](../images/debian-12-i386/tests/xfce-smoke-test.md) after a rebuild, then:

```bash
VM_E2E_ASSETS=1 pnpm test:e2e --grep "XFCE"
```

Assets ignored by Git; `validated: true` only if the published manifest and a real boot are valid.
