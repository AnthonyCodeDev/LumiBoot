# Ubuntu 18.04 LTS (bionic) i386 images

One script builds three bionic variants. Bionic is the last Ubuntu release with an i386 port and is end-of-life (ESM only), yet `archive.ubuntu.com` still serves it today, i386 included: the default mirrors are `http://archive.ubuntu.com/ubuntu` and `http://security.ubuntu.com/ubuntu`. No ISO is distributed for it.

The catalog references the three image references below, and all three carry **`validated: true`** in `packages/catalog/src/profiles.ts`: each variant was built locally, published into the Git-ignored `apps/web/public/images/<ref>/` directory and booted for real. No ISO or disk is distributed for it, the binaries are not versioned, and the CI does not build them. XFCE is the default variant (`variantOrder` 1), then X11, then CLI.

| Flavor | Reference | RAM | Disk | Readiness |
|---|---|---:|---:|---|
| `minimal` | `ubuntu-18-i386` | 512 MiB | 3 GiB | `LUMIBOOT_GUEST_READY` |
| `desktop` | `ubuntu-18-i386-desktop` | 1024 MiB | 3 GiB | `LUMIBOOT_DESKTOP_READY` |
| `xfce` | `ubuntu-18-i386-xfce` | 1024 MiB | 4 GiB | `LUMIBOOT_DESKTOP_READY` |

Readiness threshold: all three profiles wait 240 s for their marker, because software emulation can push a measured boot past 120 s (CLI 2 min 30). Expiry is diagnostic only (`boot-timeout`): the VM is not stopped, the console stays live and a late marker is still a valid proof.

## Build

Linux/WSL2 prerequisites: `debootstrap` (with its `bionic` script), `e2fsprogs`, `util-linux`, `coreutils` with `chroot` and `sha256sum`, `node`, root. Never native Windows. On this machine the default WSL distro is not `Ubuntu`: name it explicitly (`wsl -d Ubuntu -u root`) and keep `LUMIBOOT_BUILD_DIR` on a native filesystem rather than under `/mnt/c`.

```bash
sudo ./images/ubuntu-18-i386/build.sh
sudo FLAVOR=desktop ./images/ubuntu-18-i386/build.sh
sudo FLAVOR=xfce ./images/ubuntu-18-i386/build.sh
```

Outputs in `build/`, `build-desktop/` or `build-xfce/`: `rootfs.img`, `vmlinuz-686`, `initrd.img`, `manifest.json`, `packages.tsv`, `provenance.txt`. Variables: `SNAPSHOT=20240101T000000Z`, `DISK_SIZE`, `LUMIBOOT_BUILD_DIR`, `UBUNTU_MIRROR`, `UBUNTU_SECURITY_MIRROR`, `UBUNTU_KEYRING`.

Ubuntu-specific details of the script:

- Mirrors: `UBUNTU_MIRROR` defaults to `http://archive.ubuntu.com/ubuntu` and `UBUNTU_SECURITY_MIRROR` to `http://security.ubuntu.com/ubuntu`. Both are overridable; when Canonical moves bionic to the EOL archive, pass `UBUNTU_MIRROR=http://old-releases.ubuntu.com/ubuntu` and `UBUNTU_SECURITY_MIRROR=http://old-releases.ubuntu.com/ubuntu` (`old-releases` returned 404 for every bionic pocket when this pipeline was written). `SNAPSHOT` switches both to `https://snapshot.ubuntu.com/ubuntu/<SNAPSHOT>`.
- `debootstrap --arch=i386 --variant=minbase --components=main,universe`. Ubuntu puts `openbox`, `xfce4`, `zstd`, `htop` and other tools in `universe`.
- Signature check: with `UBUNTU_KEYRING=/path/to/keyring.gpg` the keyring is passed to `--keyring`; otherwise `/usr/share/keyrings/ubuntu-archive-keyring.gpg` is used when present. An Ubuntu build host has that file (and recent `ubuntu-keyring` releases still carry the 2018 archive key that signed bionic), while a Debian host has none: debootstrap then runs with `--no-check-gpg` and prints an explicit warning. `provenance.txt` records which mode was used.
- The guest kernel comes from `linux-image-generic` (bionic i386 tracks `4.15.0-*-generic`); `linux-image-686` is Debian-only and does not exist here. The extracted `vmlinuz-<version>-generic` is published under the fixed pipeline name `vmlinuz-686`.
- bionic ships `systemd-resolved` inside the `systemd` package: the standalone `systemd-resolved` binary package only appears with 22.04. The script therefore installs `systemd` and enables `systemd-resolved.service` from it.
- DRM: the bionic 4.15 kernel names the driver `bochs_drm`, renamed `bochs` in 4.20+. `guest/no-drm.conf` neutralizes both names (`blacklist` plus `install … /bin/false`) for the CLI flavor, which must stay on the text VGA console; the graphical flavors keep `bochs_drm`, the only `/dev/fb0` provider under v86.
- Kernel cmdline: a single constant, `LINUX_CMDLINE="console=tty0 console=ttyS0,115200 root=/dev/sda rw rootwait rootdelay=5"`, and `GRAPHICAL_CMDLINE="$LINUX_CMDLINE vga=0x318"`. It is passed to `write-manifest.mjs` for **all three** flavors, so every published `manifest.json` has a `boot.cmdline`; the CLI must never fall back to the provider default, which would boot without `rootwait`.

## Publishing

Copy `rootfs.img`, `vmlinuz-686`, `initrd.img` and `manifest.json` into `apps/web/public/images/<ref>/`, ignored by Git. v86 boots `bzimage + initrd + hda`, with no installer; the cmdline is `console=tty0 console=ttyS0,115200 root=/dev/sda rw rootwait rootdelay=5`, plus `vga=0x318` on the graphical variants. All three `manifest.json` files carry it as `boot.cmdline`, the CLI included.

`rootwait rootdelay=5` is **mandatory, not cosmetic**: v86 serves the disk over asynchronous HTTP Range requests, so `/dev/sda` can answer *after* the ATA probe. Without it the bionic initramfs (systemd 237) gives up on the first probe and drops to a shell with `Gave up waiting for root file system device … ALERT! /dev/sda does not exist`. The kernel does start (virtio-net comes up), which makes the failure look like a disk problem when it is a timing problem: Debian survives it, Ubuntu does not. Never publish a manifest whose `boot.cmdline` lacks `rootwait`. The exact `cp` commands per flavor are below.

Assets are Git-ignored; the image binaries are not versioned, not distributed and not built by CI. `validated: true` on each profile reflects a real boot of those published files.

## Validation

- CLI: [`tests/boot-smoke-test.md`](tests/boot-smoke-test.md)
- Openbox: [`tests/desktop-smoke-test.md`](tests/desktop-smoke-test.md)
- XFCE: [`tests/xfce-smoke-test.md`](tests/xfce-smoke-test.md)

After a rebuild: check the manifest SHA-256 values, then rerun the E2E suite with `VM_E2E_ASSETS=1`.

### Measured boots

| Flavor | Real boot | E2E spec |
|---|---:|---|
| CLI | 2 min 30 (booted twice per run: boot and restart) | `tests/e2e/session-ubuntu.spec.ts` |
| X11 + Openbox | 3 min 27 | `tests/e2e/desktop-ubuntu.spec.ts` |
| XFCE | 4 min 04 | `tests/e2e/xfce-ubuntu.spec.ts` |

All three were checked from the guest: `uname -a` reports `4.15.0-213-generic i686`, `/etc/os-release` is Ubuntu 18.04 LTS, `sudo -n whoami` returns `root`, and autologin works on both the VGA console and the serial line.

### Keeping `validated` on

A successful build is not a proof: the order is build → publish → smoke test → `validated: true`, never the other way round. It was followed for all three variants; keep it as the maintenance rule.

1. Rebuild the flavor and publish the four files into `apps/web/public/images/<ref>/`.
2. Run the matching smoke test and record the result.
3. Set `validated: true` for that profile in `packages/catalog/src/profiles.ts` only after that.
4. Prove it end to end: `VM_E2E_ASSETS=1 pnpm test:e2e --grep "Ubuntu"`.

Revert the flag as soon as a rebuild or a boot stops matching the smoke test.

## Desktop: X11 + Openbox

`ubuntu-18-i386-desktop`: Ubuntu 18.04 CLI base + Xorg, Openbox, xterm. Built locally, published under the Git-ignored `apps/web/public/images/ubuntu-18-i386-desktop/` and validated by a real boot in 3 min 27, `validated: true`.

| Element | Value |
|---|---|
| RAM / VGA | 1024 MiB / 16 MiB |
| Disk | ext4 RAW, 3 GiB |
| Session | `lumiboot` autologin → `startx` → Openbox + xterm |
| Video | `vga=0x318`, `fbdev` on `/dev/fb0`, with `modesetting` as fallback |
| Readiness | `LUMIBOOT_DESKTOP_READY:ubuntu-18-i386-desktop` |

The marker needs a live X socket, `xdpyinfo` and `openbox`; otherwise the guest emits `LUMIBOOT_DESKTOP_START_FAILED`. `LUMIBOOT_GUEST_READY` only attests `multi-user.target`. Xorg runs through the setuid `Xorg.wrap` wrapper, configured with `needs_root_rights=yes`, inside an unprivileged session; guest script 300 s, profile 240 s.

### Build and publish

Linux/WSL2 with root, never native Windows: `debootstrap`, `e2fsprogs`, `util-linux`, `node`.

```bash
sudo FLAVOR=desktop ./images/ubuntu-18-i386/build.sh
mkdir -p apps/web/public/images/ubuntu-18-i386-desktop
cp images/ubuntu-18-i386/build-desktop/{rootfs.img,vmlinuz-686,initrd.img,manifest.json} \
  apps/web/public/images/ubuntu-18-i386-desktop/
```

`build-desktop/` also holds `packages.tsv` and `provenance.txt`. Overrides: `SNAPSHOT`, `DISK_SIZE`, `LUMIBOOT_BUILD_DIR`, `UBUNTU_KEYRING`.

### Validation

[`tests/desktop-smoke-test.md`](tests/desktop-smoke-test.md) after a rebuild, then:

```bash
VM_E2E_ASSETS=1 pnpm test:e2e --grep "Ubuntu"
```

## XFCE

`ubuntu-18-i386-xfce`: Ubuntu/Xorg base + full XFCE session. Built locally, published under the Git-ignored `apps/web/public/images/ubuntu-18-i386-xfce/` and validated by a real boot in 4 min 04, `validated: true`.

| Element | Value |
|---|---|
| RAM / VGA | 1024 MiB / 16 MiB |
| Disk | ext4 RAW, 4 GiB |
| Session | `lumiboot` autologin → `startx` → `startxfce4` |
| Video | X configuration shared with Openbox, `vga=0x318` |
| Readiness | `LUMIBOOT_DESKTOP_READY:ubuntu-18-i386-xfce` |

The marker needs a live X socket, `xdpyinfo` and `xfce4-session` or `xfwm4`; otherwise the guest emits `LUMIBOOT_DESKTOP_START_FAILED`. Guest script 300 s, profile 240 s.

### Build and publish

Linux/WSL2 with root; prerequisites identical to the `desktop` flavor.

```bash
sudo FLAVOR=xfce ./images/ubuntu-18-i386/build.sh
mkdir -p apps/web/public/images/ubuntu-18-i386-xfce
cp images/ubuntu-18-i386/build-xfce/{rootfs.img,vmlinuz-686,initrd.img,manifest.json} \
  apps/web/public/images/ubuntu-18-i386-xfce/
```

`build-xfce/` also holds `packages.tsv` and `provenance.txt`. Overrides: `SNAPSHOT`, `DISK_SIZE`, `LUMIBOOT_BUILD_DIR`, `UBUNTU_KEYRING`.

### Validation

[`tests/xfce-smoke-test.md`](tests/xfce-smoke-test.md) after a rebuild, then:

```bash
VM_E2E_ASSETS=1 pnpm test:e2e --grep "Ubuntu"
```

## Known limits

- bionic is EOL (ESM): its presence on `archive.ubuntu.com` is not contractual. Pin `SNAPSHOT` for a reproducible build, and switch `UBUNTU_MIRROR`/`UBUNTU_SECURITY_MIRROR` to `http://old-releases.ubuntu.com/ubuntu` if the archive stops serving `dists/bionic/Release`.
- Without a bionic keyring the Release file is not authenticated (`--no-check-gpg`), which the build warns about and `provenance.txt` records.
- The framebuffer depends on `bochs-drm` (or `vesafb` from `vga=0x318`) providing `/dev/fb0`; if neither binds, X falls back to `modesetting` and may not find a screen.
