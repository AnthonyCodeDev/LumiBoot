# Systems

| Reference                | Variant                        | Guest RAM | Media             | Readiness                |
| ------------------------ | ------------------------------ | --------- | ----------------- | ------------------------ |
| `debian-12-i386`         | Debian 12 CLI                  | 512 MiB   | built rootfs      | `LUMIBOOT_GUEST_READY`   |
| `debian-12-i386-desktop` | Debian 12 X11/Openbox          | 1024 MiB  | built rootfs      | `LUMIBOOT_DESKTOP_READY` |
| `debian-12-i386-xfce`    | Debian 12 XFCE                 | 1024 MiB  | built rootfs      | `LUMIBOOT_DESKTOP_READY` |
| `windows-7-pro-sp1-x86`  | Windows 7 Professional SP1 x86 | 1536 MiB  | operator RAW disk | `disk-boot`              |
| `windows-7-x86`          | Windows 7 Lite x86             | 1024 MiB  | operator RAW disk | `disk-boot`              |
| `windows-10-x86`         | Windows 10 x86 32-bit          | 2048 MiB  | operator RAW disk | `disk-boot`              |

No disk, ISO or license key is shipped by this repository. This page is the index and the commands; details live next to each image under `images/<ref>/`.

## Debian 12

Prerequisites: `debootstrap`, `e2fsprogs`, `util-linux`, `coreutils`, `node`, root, Linux or WSL2.

```bash
sudo ./images/debian-12-i386/build.sh                 # CLI
sudo FLAVOR=desktop ./images/debian-12-i386/build.sh  # X11 + Openbox
sudo FLAVOR=xfce ./images/debian-12-i386/build.sh     # XFCE
```

Outputs land in `build/`, `build-desktop/` and `build-xfce/`. Copy `rootfs.img`, `vmlinuz-686`, `initrd.img` and `manifest.json` into `apps/web/public/images/<ref>/`. `<ref>` is `debian-12-i386`, `debian-12-i386-desktop` or `debian-12-i386-xfce`.

Build details, package lists, profile measurements and smoke tests: [`images/debian-12-i386/README.md`](../images/debian-12-i386/README.md).

## Windows 7

Requires an installed 32-bit RAW disk, bootable in BIOS/MBR (not UEFI/GPT), with your own license. Place it at `images/windows-7-pro-sp1-x86/disk.img`:

```bash
pnpm assets:windows7:prepare --source images/windows-7-pro-sp1-x86/disk.img --ref windows-7-pro-sp1-x86 --display-name "Windows 7 Professional SP1 x86" --architecture i386 --memory-mib 1536 --vga-mib 16 --out images/windows-7-pro-sp1-x86
pnpm assets:windows7:check
```

The Lite variant reads `images/windows-7-x86/disk.img` with 1024 MiB of guest RAM. Register it with `--ref windows-7-x86 --memory-mib 1024`.

Guest networking needs an NE2000 driver installed inside the disk, offline under QEMU. Disk preparation, driver install, readiness, HTTP Range transport and network modes: [`images/windows-7-pro-sp1-x86/README.md`](../images/windows-7-pro-sp1-x86/README.md) (Lite: [`images/windows-7-x86/README.md`](../images/windows-7-x86/README.md)).

## Windows 10 x86

Requires a 32-bit BIOS/MBR installation; a UEFI/GPT disk does not boot. Convert to RAW, keep it outside `public/`:

```powershell
qemu-img convert -O raw source.qcow2 images/windows-10-x86/disk.img
pnpm assets:windows10:prepare --source images/windows-10-x86/disk.img
pnpm assets:windows10:check
```

2048 MiB of guest RAM minimum. The virtio-net driver must already be in the disk. QEMU install, VirtualBox conversion and validation: [`images/windows-10-x86/README.md`](../images/windows-10-x86/README.md).

## Variant order

One card per family; the selector picks the launched profile.

Fields in `packages/catalog/src/profiles.ts`, copied into `OSDefinition` by `systems.ts`:

| Field | Role |
|---|---|
| `variantGroupId` | parent id; absent on the parent |
| `variantName` | short selector label |
| `variantOrder` | ascending priority; lowest = default; absent = after the ordered variants |

Each variant has its own image, profile, readiness and availability.

Current groups:

| Group | Order | Default |
|---|---|---|
| Debian (`debian-12-i386`) | XFCE, X11, CLI | XFCE |
| Windows 7 (`windows-7-x86`) | Professional, Lite | Professional |

Helpers in `packages/catalog/src/systems.ts`: `getDisplaySystems()` (parents and standalone systems), `getVariantGroup()` (members sorted by `variantOrder`), `getDefaultVariant()` (first member), `getVariantParent()` / `getVariantParentId()` (parent resolution), `hasVariants()` (group with several entries).

Adding one: image (`images.ts`), profile (`profiles.ts`), `variantGroupId`, `variantName`, `variantOrder`, catalogue/UI/E2E tests. No React component to change.

## Availability

`ready` requires a present image, a compatible profile, an integrated engine and `validated: true`. Without them the card is listed as unavailable.

## Limits

Disks are mounted read-only: guest writes stay in memory and are lost on stop. Software emulation makes boot slow. The license and the security of the disk are the operator's responsibility.
