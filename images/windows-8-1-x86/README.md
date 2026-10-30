# Windows 8.1 Pro x86

Windows 8.1 **Pro 32-bit** follows the Windows 7 RAW disk pipeline: operator-installed disk, prepared manifest, BIOS boot under v86 with the shared `disk-boot` readiness. The catalogue profile `windows-8-1-x86` carries `validated: true`, hence a `ready` availability: the card renders as "Available" and the session is launchable.

v86 only emulates 32-bit x86: only the **x86** build is supported, and the catalogue declares no 64-bit Windows 8.1 variant.

## What you must provide

No Windows ISO, image, key or download link is provided or redistributed: `disk.img` is Git-ignored and `manifest.json` stores no absolute path.

- a Windows 8.1 **32-bit disk installed**, bootable in **BIOS/MBR**; a UEFI/GPT installation does not boot under v86;
- a disk created by the operator from their own media in QEMU or VirtualBox, then converted to RAW;
- a valid Windows licence for the guest;
- Node.js 20+ and pnpm 9.14.2.

1. Put the RAW disk here: `disk.img`.
2. Regenerate the manifest: `pnpm assets:windows8:prepare`.

`manifest.json` then describes size, BIOS boot over HTTP Range and the URL `/images/windows-8-1-x86/disk.img`. Terms: [`docs/LICENSES.md`](../../docs/LICENSES.md).

> **Security.** Windows 8.1 is no longer maintained: extended support ended in 2023. The disk is mounted read-only and guest writes stay in memory, so keep the session `offline`. The `e1000` adapter is configured; guest connectivity is not covered by a test.

## Installing Windows 8.1 Pro x86 from an ISO with QEMU

1. Create an empty 20 GiB RAW disk outside `public/`; it is Git-ignored:

   ```powershell
   New-Item -ItemType Directory -Force images\windows-8-1-x86 | Out-Null
   & "C:\Program Files\qemu\qemu-img.exe" create -f raw `
     "images\windows-8-1-x86\disk.img" 20G
   ```

2. Boot the installation from the **x86** ISO; an x64 ISO does not boot. Disk on IDE, single CD boot:

   ```powershell
   & "C:\Program Files\qemu\qemu-system-i386.exe" `
     -machine pc -accel tcg -cpu max -m 2048 -smp 2 -vga std `
     -drive "file=images\windows-8-1-x86\disk.img,format=raw,if=ide,index=0,media=disk" `
     -boot order=c `
     -nic user,model=e1000
   ```

   - `-machine pc` = SeaBIOS → **MBR** table, the only layout v86 boots; never UEFI/OVMF, since a GPT installation is not bootable under v86.
   - `-m 2048` matches the LumiBoot session (`memoryMiB: 2048`).
   - `-nic user,model=e1000` matches the profile's `hardwareProfile`; the disk carries the e1000 driver Windows installed against this adapter.
   - Install on the proposed partition, using the whole disk, with a **local offline account**.

3. Once the desktop is reached, stop QEMU: the disk is ready to be registered.

## Creating a RAW disk

LumiBoot only reads RAW; `qemu-img convert` writes a new file.

```powershell
qemu-img convert -f qcow2 -O raw "<path>\Windows81-32bit.qcow2" "<path>\Windows81-32bit.img"
```

From VirtualBox: `vdi`, `vhd`/`vpc` or `vhdx`.

```powershell
# Clone VirtualBox to RAW; the original is untouched.
& "C:\Program Files\Oracle\VirtualBox\VBoxManage.exe" clonemedium `
  "<path>\Windows81-32bit.vdi" "<path>\Windows81-32bit.img" --format RAW

# Or through qemu-img.
qemu-img convert -f vpc -O raw  "<path>\Windows81-32bit.vhd"  "<path>\Windows81-32bit.img"   # VHD
qemu-img convert -f vhdx -O raw "<path>\Windows81-32bit.vhdx" "<path>\Windows81-32bit.img"  # VHDX
```

The RAW must hold a complete system disk, with an MBR table and an active NTFS partition, not a data volume.

## Registering the local disk

The disk lives outside `public/` and is ignored by Git. The command writes a `disk-boot` manifest pointing **in place** at the real file.

```powershell
pnpm assets:windows8:prepare --source images/windows-8-1-x86/disk.img
pnpm assets:windows8:check
```

The `--` separator is optional and tolerated: `pnpm assets:windows8:prepare -- --source "..."` also works. `--skip-hash` skips the SHA-256 of a 20 GiB disk; the reference manifest was produced that way.

`scripts/prepare-windows8-asset.mjs` delegates to `scripts/prepare-windows7-asset.mjs` with `ref: windows-8-1-x86`, `architecture: i386`, `memoryMiB: 2048`, `vgaMiB: 16`, `out: images/windows-8-1-x86`, and forwards `--check`, `--force`, `--skip-hash`, `--resume`, `--json`, `--copy-to`. Before any generation it refuses a lone ISO or a container such as `.qcow`, `.qcow2`, `.vhd`, `.vhdx`, `.vmdk` or `.vdi`: the `disk-boot` pipeline requires an installed RAW.

The generator opens the source read-only, streams the SHA-256 and writes only `images/windows-8-1-x86/manifest.json` + `provenance.txt`. `WINDOWS8_IMG` supplies the default source. Shared tooling: [`windows-7-pro-sp1-x86/README.md`](../windows-7-pro-sp1-x86/README.md).

## Guest RAM: 2048 MiB minimum

The `windows-8-1-x86` profile declares `minMemoryMiB: 2048` and `configuration.memoryMiB: 2048` in `packages/catalog/src/profiles.ts`. v86 rounds memory to a multiple of 128 KiB; 2048 MiB passes as is. Below that, the guest boots slower or refuses to boot.

## Emulated hardware: ACPI + e1000

The profile declares `hardwareProfile: { ...pcHardware('e1000'), acpi: true }` in `packages/catalog/src/profiles.ts`:

- **ACPI**, required by the NT family since Vista under v86;
- **e1000**, matching the adapter the disk was installed against (`-nic user,model=e1000`). v86 also exposes `ne2k` and `virtio`; the choice comes from the driver present in that disk, not from an engine limitation.

Guest connectivity needs a non-`offline` network mode, for instance a paired `local-proxy`, and a check inside the guest: `ipconfig`, name resolution, HTTP. No test covers it. Modes and transports: [`docs/network/network.md`](../../docs/network/network.md).

## Development and HTTP Range verification

`pnpm dev` enables the Vite middleware `scripts/lib/disk-asset-dev.mjs`, which discovers every `images/<ref>/manifest.json` with `boot.mode === 'disk-boot'` and serves the disk **in place** on `/images/<ref>/disk.img` over **HTTP Range `206`**.

PowerShell check, with the dev server on `5173`:

```powershell
# 1. Public manifest, without `source` or `provenance`.
Invoke-RestMethod 'http://127.0.0.1:5173/images/windows-8-1-x86/manifest.json'

# 2. Partial range, never a full 200.
$response = Invoke-WebRequest `
  -Uri 'http://127.0.0.1:5173/images/windows-8-1-x86/disk.img' `
  -Headers @{ Range = 'bytes=0-0' }
$response.StatusCode                # expected: 206
$response.Headers['Content-Range']  # expected: bytes 0-0/<size>
$response.Headers['Accept-Ranges']  # expected: bytes
```

A `200` response to a `Range` request is incompatible with the v86 async reader (`hda.async`). Details: [`windows-7-pro-sp1-x86/README.md`](../windows-7-pro-sp1-x86/README.md#range-transport).

## Validation status

**Declared validated.** The operator boots this session from their own installed RAW disk, so the catalogue profile carries `validated: true` and availability derives to `ready` ("Available"): the card is launchable. This is an explicit operator decision, not a test proof: `tests/e2e` contains no Windows 8.1 Pro x86 spec and no run is recorded in the repository.

Manifest generated with `pnpm assets:windows8:prepare --skip-hash`: no SHA-256 in the manifest, which documents size and `mtime` only. Measured disk (`qemu-img info`, operator-provided file):

| Property | Measured value |
|---|---|
| Logical size | 21 474 836 480 bytes (20 GiB) |
| Allocated size | 6 712 262 656 bytes (~6.25 GiB, `actual-size`) |
| Partitioning | Bootable MBR/BIOS: active NTFS system partition (350 MiB) + NTFS Windows partition (~19.66 GiB), no GPT |
| SHA-256 | not computed (`--skip-hash`) |

## Distribution

- sparse disk, ~6.25 GiB for 20 GiB logical, served in place over HTTP Range: v86 only reads the required blocks;
- in production, nginx forbids proprietary Windows images under `/images/`: `infra/nginx/site.conf` returns 404 on `location ~* "^/images/.*(windows|winxp|winvista|win[0-9])"`. The in-place middleware only exists in development, so hosting the disk is the operator's responsibility.

## Limitations

- very slow boot: POST, NT loader and desktop all run under software emulation;
- ephemeral guest storage: read-only source, v86 writes lost on stop;
- no versioned E2E boot spec: `validated: true` is an explicit operator declaration, not a test proof;
- guest network connectivity not covered by a test, despite `e1000`;
- disk licence and security are the operator's responsibility.

## Validation checklist

- [x] RAW `images/windows-8-1-x86/disk.img`: 32-bit, MBR/BIOS, with an active NTFS system partition, no GPT.
- [x] `manifest.json` served, `ref` / `architecture: i386` / `memoryMiB: 2048` consistent with the profile.
- [ ] HTTP Range probe: `206` + `Content-Range` + `Accept-Ranges: bytes`, not run against the reference manifest.
- [ ] Real boot E2E: no Windows 8.1 Pro x86 spec is versioned under `tests/e2e`; the profile is declared `validated: true` from the operator's real boot, so this box stays open until such a spec exists.
- [ ] Guest RAM and boot time: not measured.

Unproven: no VGA screenshot of the desktop is attached and `pnpm assets:windows8:check` only checks source readability, size and `mtime` (the reference manifest carries no SHA-256).

`validated` lives on the catalogue profile and availability derives from it; see `packages/catalog/src/availability.ts`. Any change to the disk or the profile requires regenerating the manifest, re-checking the boot in the operator's environment, then updating this document and [`docs/LICENSES.md`](../../docs/LICENSES.md).

### `validated` status

`ready` requires a present image, a compatible profile, an integrated engine and `validated: true`; `getEffectiveAvailability` downgrades a declared `ready` without proof to the non-ready state. Catalogue index and variant rules: [`docs/systems.md`](../../docs/systems.md).
