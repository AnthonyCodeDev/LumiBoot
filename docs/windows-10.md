# Windows 10 under v86

Windows 10 **32-bit** follows the Windows 7 local RAW disk pipeline: disk installed by the operator, prepared then BIOS-booted under v86, shared `disk-boot` readiness. The catalogue profile `windows-10-x86` carries `validated: true`, hence a `ready` availability.

v86 only emulates 32-bit x86: only the **x86** build is supported; the catalogue declares no 64-bit variant.

No Windows ISO, image, key or download link is provided, downloaded or redistributed; licence and media are the operator's responsibility.

## Prerequisites

- Windows 10 **32-bit disk installed**, bootable in **BIOS/MBR** (a UEFI/GPT installation does not boot under v86);
- disk created by the operator from their own media (QEMU, VirtualBox), then converted to RAW;
- valid Windows licence for the guest;
- Node.js 20+ and pnpm 9.14.2.

> **Security** — Windows 10 is no longer maintained (standard support ended in 2025). The disk is mounted read-only and guest writes stay in memory: keep the session `offline`. The `virtio-net` adapter is configured; guest connectivity is not covered by a test.

## Installing Windows 10 x86 from an ISO (QEMU)

1. Create an empty 40 GiB RAW disk (outside `public/`, ignored by Git):

   ```powershell
   New-Item -ItemType Directory -Force images\windows-10-x86 | Out-Null
   & "C:\Program Files\qemu\qemu-img.exe" create -f raw `
     "images\windows-10-x86\disk.img" 40G
   ```

2. Boot the installation from the **x86** ISO (an x64 ISO, e.g. `..._x64_dvd_....iso`, does not boot), disk on IDE, single CD boot:

   ```powershell
   & "C:\Program Files\qemu\qemu-system-i386.exe" `
     -machine pc `
     -m 3072 `
     -vga std `
     -drive "file=images\windows-10-x86\disk.img,format=raw,if=ide,index=0,media=disk" `
     -cdrom "D:\ISO\fr_windows_10_enterprise_ltsc_2021_x86_dvd.iso" `
     -boot once=d `
     -nic none
   ```

   - `-machine pc` = SeaBIOS → **MBR** table, the only layout v86 can boot; never UEFI/OVMF (GPT installation, not bootable under v86).
   - `-m 3072` only applies to the installation; the LumiBoot session uses `memoryMiB: 2048`.
   - Install on the proposed partition (whole disk), with a **local offline account**.

3. Once the desktop is reached, stop QEMU: the disk is ready to be registered.

Network driver: the provided Windows 10 x86 image embeds the **VirtIO NetKVM x86** driver. If the disk lacks it, inject it offline under QEMU (`-nic user,model=virtio` + driver media) **before** preparing the manifest: the source served by v86 is read-only, so the driver must be present in the disk at preparation time.

## Creating a RAW disk

LumiBoot only reads RAW; the source is never modified (`qemu-img convert` writes a new file).

```powershell
qemu-img convert -f qcow2 -O raw "D:\VM\Windows10-32bit.qcow2" "D:\VM\Windows10-32bit.img"
```

From VirtualBox (`vdi`, `vhd`/`vpc`, `vhdx`):

```powershell
# Clone VirtualBox to RAW (the original is untouched).
& "C:\Program Files\Oracle\VirtualBox\VBoxManage.exe" clonemedium `
  "D:\VM\Windows10-32bit.vdi" "D:\VM\Windows10-32bit.img" --format RAW

# Or through qemu-img.
qemu-img convert -f vpc -O raw  "D:\VM\Windows10-32bit.vhd"  "D:\VM\Windows10-32bit.img"   # VHD
qemu-img convert -f vhdx -O raw "D:\VM\Windows10-32bit.vhdx" "D:\VM\Windows10-32bit.img"  # VHDX
```

The RAW must hold a complete system disk (MBR table + active NTFS partition), not a data volume.

## Registering the local disk

The disk lives outside `public/` (hence outside the Vite bundle) and is ignored by Git; the command writes a `disk-boot` manifest pointing **in place** at the real file.

```powershell
pnpm assets:windows10:prepare --source "D:\VM\Windows10-32bit.img"
pnpm assets:windows10:check
```

The `--` separator is optional and tolerated: `pnpm assets:windows10:prepare -- --source "..."` also works. `--skip-hash` skips the SHA-256 of a 40 GiB disk (the disk is never modified); the reference manifest was produced that way.

`scripts/prepare-windows10-asset.mjs` delegates to `scripts/prepare-windows7-asset.mjs` with `ref: windows-10-x86`, `architecture: i386`, `memoryMiB: 2048`, `vgaMiB: 16`, `out: images/windows-10-x86`, and forwards `--check`, `--force`, `--skip-hash`, `--resume`, `--json`, `--copy-to`. Before any generation it refuses a lone ISO or a container (`.qcow`, `.qcow2`, `.vhd`, `.vhdx`, `.vmdk`, `.vdi`): the `disk-boot` pipeline requires an installed RAW.

The generator opens the source read-only, computes the SHA-256 in streaming mode and only writes `images/windows-10-x86/manifest.json` + `provenance.txt`. `WINDOWS10_IMG` supplies the default source. Shared tooling: [`windows-7.md`](windows-7.md).

## Guest RAM: 2048 MiB minimum

The `windows-10-x86` profile declares `minMemoryMiB: 2048` and `configuration.memoryMiB: 2048` (`packages/catalog/src/profiles.ts`). v86 rounds memory to a multiple of 128 KiB; 2048 MiB passes as is. Below that, the guest is slower or refuses to boot.

## Emulated hardware: ACPI + virtio-net

The profile declares `hardwareProfile: { ...pcHardware('virtio'), acpi: true }` (`packages/catalog/src/profiles.ts`):

- **ACPI**, required by the NT family (Vista and later) under v86;
- **virtio-net** (PCI device `0x1AF4:0x1041`, virtio 1.0), matching the **VirtIO NetKVM x86** driver present in the provided image. v86 also exposes `ne2k`; Windows 7's choice comes from the driver present in that disk, not from a limitation of the engine.

Windows 10 x86 guest connectivity is not covered by a test: proving it requires a non-`offline` network mode (e.g. a paired `local-proxy`) **and** a check inside the guest (`ipconfig`, name resolution/HTTP). Guest networking stays unproven.

## Development and HTTP Range verification

`pnpm dev` enables the Vite middleware `scripts/lib/disk-asset-dev.mjs`, which discovers every `images/<ref>/manifest.json` with `boot.mode === 'disk-boot'` and serves the disk **in place** on `/images/<ref>/disk.img` over **HTTP Range `206`**.

PowerShell check (dev server on `5173`):

```powershell
# 1. Public manifest (without `source` or `provenance`).
Invoke-RestMethod 'http://127.0.0.1:5173/images/windows-10-x86/manifest.json'

# 2. Partial range, never a full 200.
$response = Invoke-WebRequest `
  -Uri 'http://127.0.0.1:5173/images/windows-10-x86/disk.img' `
  -Headers @{ Range = 'bytes=0-0' }
$response.StatusCode                # expected: 206
$response.Headers['Content-Range']  # expected: bytes 0-0/<size>
$response.Headers['Accept-Ranges']  # expected: bytes
```

A `200` response to a `Range` request is incompatible with the v86 async reader (`hda.async`). Details: [`windows-7-streaming.md`](windows-7-streaming.md).

## Validation (real boot)

Real boot proven on **2026-10-18** by `tests/e2e/windows10-desktop.spec.ts` with the local assets:

```powershell
$env:VM_E2E_ASSETS='1'; $env:WIN10_DISK='1'; `
  pnpm exec playwright test tests/e2e/windows10-desktop.spec.ts
```

Disk `images/windows-10-x86/disk.img` (RAW):

| Property | Measured value |
|---|---|
| Logical size | 42 949 672 960 bytes (40 GiB) |
| Allocated size (sparse) | ~6.2 GiB (`qemu-img info` → `disk size 6.2G`) |
| Partitioning | Bootable MBR/BIOS: active NTFS "System Reserved" + Windows + recovery — no GPT |
| SHA-256 | `C72345F3D32EFCCEAFADDCE834357C4C57B81F672C8C46C1422F6D9EEF218129` |

Manifest generated with `pnpm assets:windows10:prepare --skip-hash`: no SHA-256 in the manifest. Two successive runs:

| Network adapter | State | VGA screen (1024×768) | Disk served (HTTP Range) | Guest RAM | Boot click → screen |
|---|---|---|---|---|---|
| `ne2k` | `running` (after a real `ide-read-end`) | `nonBlackRatio=0.499`, `distinctColors=50`, `stablePolls=4` | **481.01 MiB over 13 944 requests** | 2048 MiB | **337.3 s** |
| `virtio` (current configuration) | `running` (same) | same | **503.34 MiB over 14 814 requests** | 2048 MiB | **373.3 s** |

Clean shutdown (`data-state=stopped`) validated in both cases. Test thresholds: `nonBlackRatio > 0.3`, `distinctColors > 32`, 4 stable polls; the coloured screen completes the machine proof, it does not replace it.

## Distribution

- sparse disk: ~6.2 GiB allocated for 40 GiB logical;
- served in place over HTTP Range; v86 only reads the required blocks (~500 MiB to reach the desktop);
- in production, nginx forbids proprietary Windows images under `/images/` (`infra/nginx/site.conf`, `location ~* "^/images/.*(windows|winxp|winvista|win[0-9])" { return 404; }`); the in-place middleware only exists in development; hosting the disk is the operator's responsibility.

## Limitations

- very slow boot (POST, NT loader and desktop under software emulation);
- ephemeral guest storage: read-only source, v86 writes lost on stop;
- guest network connectivity not covered by a test, despite `virtio-net` and the VirtIO NetKVM driver;
- disk served in local development only;
- disk licence and security are the operator's responsibility.

## Validation checklist

The `windows-10-x86` profile is `validated: true`, aligned with Windows 7; only observed proof counts.

- [x] RAW present (`images/windows-10-x86/disk.img`), 32-bit, bootable MBR/BIOS (active NTFS + Windows + recovery, no GPT).
- [x] `manifest.json` served, `ref` / `architecture: i386` / `memoryMiB: 2048` fields consistent with the profile.
- [x] HTTP Range probe: `206` + `Content-Range` + `Accept-Ranges: bytes`.
- [x] Real boot E2E passed on 2026-10-18 (`VM_E2E_ASSETS=1`).
- [x] Coloured and stable VGA canvas (`nonBlackRatio=0.499`, `distinctColors=50`, `stablePolls=4`), not a black POST screen.
- [x] Measurements recorded: 337.3 s (`ne2k`) / 373.3 s (`virtio`), 481.01 / 503.34 MiB served, 2048 MiB of RAM.

Unproven: no VGA screenshot of the desktop attached as proof; `pnpm assets:windows10:check` is not run against the reference manifest, which was produced with `--skip-hash` and carries no SHA-256 (the command checks source readability, size and `mtime`); guest network not covered by a test, `virtio-net` and driver in place, connectivity unproven.

`validated` lives on the catalogue profile, availability is derived from it (`packages/catalog/src/availability.ts`): never a hard-coded `ready`. Any change to the disk or the profile requires rerunning the E2E, recording the proof, then updating this document and `docs/LICENSES.md`.

### `validated` status

`ready` requires a present image, a compatible profile, an integrated engine and `validated: true` (`getEffectiveAvailability`); a declared `ready` without proof is downgraded to the non-ready state of `packages/catalog/src/availability.ts`.
