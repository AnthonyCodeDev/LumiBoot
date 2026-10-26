# Debian 12 i386 images

One script builds three Bookworm variants; all three carry `validated: true` (`packages/catalog/src/profiles.ts`).

| Flavor | Reference | RAM | Disk | Readiness |
|---|---|---:|---:|---|
| `minimal` | `debian-12-i386` | 512 MiB | 3 GiB | `LUMIBOOT_GUEST_READY` |
| `desktop` | `debian-12-i386-desktop` | 1024 MiB | 3 GiB | `LUMIBOOT_DESKTOP_READY` |
| `xfce` | `debian-12-i386-xfce` | 1024 MiB | 4 GiB | `LUMIBOOT_DESKTOP_READY` |

## Build

Linux/WSL2 prerequisites: `debootstrap`, `e2fsprogs`, `util-linux`, `coreutils` (`chroot`, `sha256sum`), `node`, root.

```bash
sudo ./images/debian-12-i386/build.sh
sudo FLAVOR=desktop ./images/debian-12-i386/build.sh
sudo FLAVOR=xfce ./images/debian-12-i386/build.sh
```

Outputs in `build/`, `build-desktop/` or `build-xfce/`: `rootfs.img`, `vmlinuz-686`, `initrd.img`, `manifest.json`, `packages.tsv`, `provenance.txt`. Variables: `SNAPSHOT=20240101T000000Z`, `DISK_SIZE`, `LUMIBOOT_BUILD_DIR`.

## Publishing

Copy `rootfs.img`, `vmlinuz-686`, `initrd.img` and `manifest.json` into `apps/web/public/images/<ref>/`, ignored by Git. v86 boots `bzimage + initrd + hda`, with no installer; cmdline `console=tty0 console=ttyS0,115200 root=/dev/sda rw`, plus `vga=0x318` on the graphical variants.

## Validation

- CLI: [`tests/boot-smoke-test.md`](tests/boot-smoke-test.md)
- Openbox: [`tests/desktop-smoke-test.md`](tests/desktop-smoke-test.md)
- XFCE: [`tests/xfce-smoke-test.md`](tests/xfce-smoke-test.md)

After a rebuild: check the manifest SHA-256 values, then rerun the E2E suite with `VM_E2E_ASSETS=1`.
