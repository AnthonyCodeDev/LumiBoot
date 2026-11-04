# Windows 11 x64

Windows 11 **64-bit** follows the Windows 7/8.1/10 local RAW disk pipeline — operator-installed disk, prepared manifest, HTTP Range transport, reads only — with one material difference: the disk is **UEFI/GPT** and boots through **OVMF** on the **v64** engine, on a Q35/ICH9 AHCI machine.

The catalogue profile `windows-11-x64` now carries `validated: true`: the real boot is proven. With the patched v64 build (see [Validation status](#validation-status)) the guest boots OVMF → `Windows Boot Manager` → Windows 11 and reaches the **Windows 11 sign-in screen**, so the card is "Available" and the availability is `ready`. The desktop login itself is still under validation — see the honest scope of the proof below.

## What you must provide

No Windows ISO, image, key or download link is provided or redistributed: `disk.img` is Git-ignored and `manifest.json` stores no absolute path.

- a Windows 11 **x64 disk installed**, bootable in **UEFI/GPT** — unlike Windows 7, 8.1 and 10, which are BIOS/MBR: the ESP must carry `/EFI/Microsoft/Boot/bootmgfw.efi` and `/EFI/BOOT/BOOTX64.EFI`;
- the **OVMF variable store** produced by that installation, `uefi-vars.fd`: it holds the `Windows Boot Manager` entry pointing at the ESP. Without it OVMF falls back to its built-in shell and the disk is not booted;
- BitLocker **disabled** on the system volume (LumiBoot exposes neither a TPM 2.0 nor a Secure Boot database);
- a valid Windows licence for the guest;
- Node.js 20+ and pnpm 9.14.2.

1. Put the RAW disk here: `disk.img`.
2. Put the OVMF store next to it: `uefi-vars.fd`.
3. Regenerate the manifest: `pnpm assets:windows11:prepare`.

`manifest.json` then describes size and mtime of both files, the `firmware.vars` SHA-256, the UEFI disk boot over HTTP Range and the URLs `/images/windows-11-x64/disk.img` and `/images/windows-11-x64/uefi-vars.fd`. Terms: [`docs/LICENSES.md`](../../docs/LICENSES.md).

## Pipeline

```powershell
pnpm assets:windows11:prepare                        # images/windows-11-x64/disk.img + uefi-vars.fd
pnpm assets:windows11:prepare --source "<path>\Windows11-x64.img" --firmware-vars "<path>\uefi-vars.fd"
pnpm assets:windows11:check
```

The `--` separator is optional and tolerated. `WINDOWS11_IMG` supplies the default source.

`scripts/prepare-windows11-asset.mjs` delegates to `scripts/prepare-windows7-asset.mjs` with `ref: windows-11-x64`, `architecture: x86_64`, `memoryMiB: 4096`, `vgaMiB: 32`, `engine: v64`, `firmware-vars: images/windows-11-x64/uefi-vars.fd` and `out: images/windows-11-x64`, and forwards `--check`, `--force`, `--skip-hash`, `--resume`, `--json`, `--copy-to`. Every value can be overridden: `--engine` and `--firmware-vars` are defaults, not hard-coded.

The shared generator:

- records `"engine": { "id": "v64" }` instead of the v86 lock block, and refuses `--engine v64` for an architecture other than `x86_64`;
- reads the OVMF store and records `"firmware": { "type": "uefi", "vars": { fileName, url, size, mtimeMs, sha256 } }`. The store is small (540 672 bytes for this installation), so its SHA-256 is always computed, `--skip-hash` included;
- `--check` verifies the disk by size/mtime (and SHA-256 when the manifest has one) **and** the variable store by size/mtime/SHA-256, looking it up under the manifest directory, then next to the disk;
- refuses a lone ISO or a container such as `.qcow`, `.qcow2`, `.vhd`, `.vhdx`, `.vmdk` or `.vdi`: the `disk-boot` pipeline requires an installed RAW.

The generator opens the source read-only, streams the disk SHA-256 when asked and writes only `images/windows-11-x64/manifest.json` + `provenance.txt`. For a 64 GiB disk the reference manifest was produced with `--skip-hash`: the disk is documented by size and mtime, the OVMF store by size, mtime and SHA-256. Shared tooling: [`windows-7-pro-sp1-x86/README.md`](../windows-7-pro-sp1-x86/README.md).

## How the session boots

v64 loads the whole-disk manifest (`readiness.mode: "disk-boot"`), mounts the disk as `hda` with `async: true` and streams it over HTTP Range, then boots OVMF:

| Item | Value |
|---|---|
| Engine | v64 (WebAssembly JIT), `engine.id: v64` |
| Firmware | UEFI through OVMF `edk2-stable202408`, code image `/v64/ovmf-code.fd` |
| Variable store | `firmware.vars` from the manifest, `/images/windows-11-x64/uefi-vars.fd` |
| Machine | Q35 (`v64Machine: q35`) |
| Disk controller | ICH9 AHCI, disk on SATA port 0 (`8086:2922`, `storahci`, boot-critical) |
| NIC | Intel `e1000` (`8086:100E`), matching the disk's driver |
| Video | stdvga/bochs VGA (`v64Graphics: bochs_vga`), 32 MiB VRAM |
| CPU | x86-64-v2 baseline (`v64CpuFeatures: x86-64-v2`), 1 core |
| RAM | 4096 MiB |

The profile in `packages/catalog/src/profiles.ts` carries those values as `configuration.extra` (`v64CpuCores`, `v64Graphics`, `v64Machine`, `v64Firmware`, `v64CpuFeatures`) plus `hardwareProfile: { ...pcHardware('e1000'), machine: 'q35', acpi: true }`. `V64Provider` reads them as defaults; a caller can still override them.

Every piece matters. A BIOS/MBR disk has no ESP, so OVMF finds nothing to boot. A disk installed on a virtio-blk controller needs `viostor` to **boot**, which this image does not carry: `storahci` is boot-critical here, so the controller must stay AHCI. A different NIC model only costs the network, not the boot.

## Installing Windows 11 x64 from an ISO with QEMU

The disk registered in this repository was installed with **QEMU 9.2.0**, machine `pc-q35-9.2` (`Standard PC (Q35 + ICH9, 2009)`) and OVMF `edk2-stable202408`. The reference procedure below reproduces it.

1. Create the 64 GiB RAW disk and seed the OVMF variable store from QEMU's template:

   ```powershell
   New-Item -ItemType Directory -Force images\windows-11-x64 | Out-Null
   & "C:\Program Files\qemu\qemu-img.exe" create -f raw `
     "images\windows-11-x64\disk.img" 64G
   Copy-Item "C:\Program Files\qemu\share\edk2-i386-vars.fd" `
     "images\windows-11-x64\uefi-vars.fd"
   ```

   `edk2-i386-vars.fd` is the NVRAM template that matches the `edk2-x86_64-code.fd` code image; the name carries the toolchain family, not the guest bitness.

2. Boot the installation from the **x64** ISO, disk on AHCI port 0, `e1000`, stdvga:

   ```powershell
   & "C:\Program Files\qemu\qemu-system-x86_64.exe" `
     -machine q35 `
     -m 4096 `
     -cpu max `
     -smp 2 `
     -vga std `
     -device e1000 `
     -drive if=pflash,format=raw,readonly=on,file="C:\Program Files\qemu\share\edk2-x86_64-code.fd" `
     -drive if=pflash,format=raw,file="images\windows-11-x64\uefi-vars.fd" `
     -device ich9-ahci,id=sata `
     -drive id=disk,file=images\windows-11-x64\disk.img,format=raw,if=none `
     -device ide-hd,drive=disk,bus=sata.0 `
     -cdrom "D:\ISO\Win11_24H2_French_x64.iso" `
     -boot once=d `
     -nic none
   ```

   - `-machine q35` gives `pc-q35-9.2` on QEMU 9.2: the same chipset family the LumiBoot profile declares. Never `-machine pc`.
   - the two `if=pflash` drives are OVMF: the code image is read-only, the variable store is writable and **must be kept** after the installation, since it is what remembers `Windows Boot Manager`;
   - `-cpu max` keeps every feature 24H2 asks for. LumiBoot runs a narrower `x86-64-v2` baseline, which 24H2 accepts;
   - Windows 11 24H2 requires TPM 2.0 and Secure Boot: add `-chardev socket,id=chrtpm,path=... -tpmdev emulator,id=tpm0,chardev=chrtpm -device tpm-tis,tpmdev=tpm0`, or use the unattended-install bypass of your choice. LumiBoot exposes neither, so **disable BitLocker** before registering the disk;
   - `-nic none` during the installation: the session's `e1000` driver comes with Windows, no extra media is needed;
   - install on the whole disk with the default UEFI/GPT layout (ESP, MSR, Windows, Recovery) and a **local offline account**.

3. Once the desktop is reached, shut the guest down **cleanly**, then stop QEMU. `disk.img` and `uefi-vars.fd` are ready to be registered together.

The reference installation measured here:

| Property | Value |
|---|---|
| Windows version | 11 24H2, build 26100 |
| Partitioning | GPT/UEFI: ESP 100 MiB FAT32, MSR 16 MiB, Windows NTFS 63.25 GiB, Recovery 642 MiB |
| Boot files | `/EFI/Microsoft/Boot/bootmgfw.efi`, `/EFI/BOOT/BOOTX64.EFI` |
| Controllers | Q35/ICH9 AHCI `8086:2922` (`storahci`), NIC Intel `8086:100E`, VGA `1234:1111` |
| BitLocker | disabled |

## Creating a RAW disk

LumiBoot only reads RAW; `qemu-img convert` writes a new file.

```powershell
qemu-img convert -f qcow2 -O raw "<path>\Windows11-64bit.qcow2" "<path>\Windows11-64bit.img"
qemu-img convert -f vhdx -O raw "<path>\Windows11-64bit.vhdx" "<path>\Windows11-64bit.img"
& "C:\Program Files\Oracle\VirtualBox\VBoxManage.exe" clonemedium `
  "<path>\Windows11-64bit.vdi" "<path>\Windows11-64bit.img" --format RAW
```

The RAW must hold a complete **GPT** system disk with an ESP, not a data volume. A VirtualBox UEFI installation also produces a GPT disk and boots, as long as its ESP carries `bootmgfw.efi`.

## Guest RAM: 4096 MiB

The `windows-11-x64` profile declares `minMemoryMiB: 4096` and `configuration.memoryMiB: 4096`. Windows 11 needs more headroom than Windows 10 x86, and v64 has to hold the disk cache of a 64 GiB image. Below that the guest boots slower, swaps and may refuse the upgrade path.

## Development and HTTP Range verification

`pnpm dev` enables the Vite middleware `scripts/lib/disk-asset-dev.mjs`, which discovers every `images/<ref>/manifest.json` with `boot.mode === 'disk-boot'` and serves **the disk and its UEFI variable store** in place on `/images/<ref>/disk.img` and `/images/<ref>/uefi-vars.fd`, over **HTTP Range `206`**.

PowerShell check, with the dev server on `5173`:

```powershell
# 1. Public manifest, without `source` or `provenance`.
Invoke-RestMethod 'http://127.0.0.1:5173/images/windows-11-x64/manifest.json'

# 2. Partial range, never a full 200.
$response = Invoke-WebRequest `
  -Uri 'http://127.0.0.1:5173/images/windows-11-x64/disk.img' `
  -Headers @{ Range = 'bytes=0-0' }
$response.StatusCode                # expected: 206
$response.Headers['Content-Range']  # expected: bytes 0-0/68719476736
$response.Headers['Accept-Ranges']  # expected: bytes

# 3. The OVMF store is served too.
$response = Invoke-WebRequest `
  -Uri 'http://127.0.0.1:5173/images/windows-11-x64/uefi-vars.fd' `
  -Headers @{ Range = 'bytes=0-0' }
$response.StatusCode                # expected: 206
```

A `200` response to a `Range` request is incompatible with the v64 async disk reader. Details: [`windows-7-pro-sp1-x86/README.md`](../windows-7-pro-sp1-x86/README.md#range-transport).

## Validation status

`validated: true` — a real boot is proven, up to the Windows 11 sign-in screen. The **desktop login is still under validation**: the proof below stops at the sign-in screen, so the card is "Available" for a boot that a visitor can watch, not for a guaranteed logged-in desktop yet.

### What was broken, and the fix

The first boots bugchecked with `0x5C` (`HAL_INITIALIZATION_FAILED`, subcode `0x14`): Windows' HAL never left `HalpInitializeClock`. Root cause on the v64 side: the board delivered ISA **IRQ 0** to I/O APIC input 0, while Windows (like QEMU's q35) programs the **cascade input 2** and never unmasks input 0. With `v64Hpet: true`, the HPET's legacy replacement route raises IRQ 0, so the tick was dropped and `[obj+0x40]` stayed 0 for the whole wait loop.

[`scripts/patches/v64-ioapic-irq0-gsi2.patch`](../../scripts/patches/v64-ioapic-irq0-gsi2.patch) fixes it, together with the other gaps that blocked the HAL clock:

- `src/rust/cpu/ioapic.rs`: `gsi_input(i)` maps ISA IRQ 0 to I/O APIC input 2 in `set_irq_internal` and `clear_irq_internal` (QEMU's `ioapic_set_irq`: "ISA IRQs map to GSI 1-1 except for IRQ0 which maps to GSI 2");
- `src/acpi_tables.js`: the MADT gains the matching Interrupt Source Override `IRQ 0 -> GSI 2` (`build_xrupt_override(0, 2, 0)`), so Linux-style guests that read the MADT agree with the routing;
- `src/hpet.js`: the main counter period is 100 ns (`PERIOD_FS = 100000000`), as QEMU's q35 `GCAP_ID` reports;
- `src/rust/cpu/instructions_0f.rs`: extended CPUID leaves `0x80000001`, `0x80000007` (invariant TSC) and `0x80000008`, with `0x80000000` reporting `0x80000008` as the highest leaf.

The patch is recorded in `scripts/v64-assets.lock.json` (`patch`, `patchFile`, `build.patches`): the core v64 binaries served from `apps/web/public/v64/` are the upstream `74d2bafc` build **with this patch applied**, not the upstream bytes. `prepare-v64-assets.mjs` fails loudly rather than silently installing an unpatched binary.

### Measured proof

| Measurement | Value |
|---|---|
| Guest state at the end of the probe | Windows 11 **sign-in screen** ("LumiBoot / Welcome"), cursor follows the injected mouse |
| `KiBugCheckData` | `0x0, 0x0, …` (all eight qwords) |
| HPET timer 0 | 289 494 firings in 720 s (the HAL keeps re-arming it) |
| Disk read high-water (probe) | **1138.6 MiB** (was 108.7 MiB when it bugchecked) |
| Full E2E boot (`windows11-desktop.spec.ts`) | **1932.4 s** from the start click to a stable VGA screen |
| E2E VGA proof | 1280x800, `nonBlackRatio=0.974`, `distinctColors=134`, 4 stable polls |
| E2E served disk (HTTP Range) | 1 577.47 MiB over 44 586 requests |

Captures: `halclock-signin-clean.png` (sign-in screen, clean release build) and the persistent E2E screenshots `test-results/windows11-vga*.png`. Logs: `.tmp/e2e-win11.log`, `.tmp/probe/V64-RELEASE-REPORT.md` (untracked diagnostics).

Measured facts about the registered assets:

| Property | Measured value |
|---|---|
| Logical disk size | 68 719 476 736 bytes (64 GiB), RAW |
| Disk mtime | `1793400322475` |
| Disk SHA-256 | not computed (size + mtime only) |
| OVMF store | 540 672 bytes, mtime `1793399417613` |
| OVMF store SHA-256 | `3a938f1ab967451fd011b4ef55d28da6cf02dc456cede1eb8eee967696a4434f` |
| Firmware | UEFI, OVMF `edk2-stable202408` |
| Machine | `pc-q35-9.2` (`Standard PC (Q35 + ICH9, 2009)`) |

Validation checklist:

- [x] RAW `images/windows-11-x64/disk.img`: 64 GiB, GPT/UEFI, ESP with `bootmgfw.efi` and `BOOTX64.EFI`.
- [x] OVMF variable store `images/windows-11-x64/uefi-vars.fd` (540 672 bytes) served next to the disk, SHA-256 recorded in the manifest.
- [x] `manifest.json` consistent with the profile: `ref` / `architecture: x86_64` / `memoryMiB: 4096` / `engine.id: v64` / `firmware.type: uefi`.
- [x] HTTP Range probe on `disk.img`: `206` + `Content-Range` + `Accept-Ranges: bytes` (the E2E run served 44 586 ranges).
- [x] Real boot: OVMF loads `Windows Boot Manager` and Windows 11 reaches the **sign-in screen** on the VGA canvas, with `KiBugCheckData = 0`.
- [x] `validated: true`, flipped after the boot above was recorded here and in [`docs/v64.md`](../../docs/v64.md).
- [ ] Desktop login: reaching a logged-in desktop (independent of the sign-in screen) is still under validation.

`tests/e2e/windows11-desktop.spec.ts` holds the boot probe: it stays opt-in behind `VM_E2E_ASSETS=1` and a present local disk. Its colored-and-stable-screen check is what recorded the 1932.4 s run; it is a **visual** proof, which is why the desktop login is listed separately.

`validated` lives on the catalogue profile and availability derives from it; see `packages/catalog/src/availability.ts`. `ready` requires a present image, a compatible profile, an integrated engine and `validated: true`.

## Distribution

- the disk is served in place over HTTP Range: v64 only reads the blocks it needs, so a 64 GiB sparse image costs far less than its logical size per session;
- `disk.img` is Git-ignored and never distributed; `provenance.txt` is Git-ignored too;
- `uefi-vars.fd` is versioned because it is small (540 672 bytes) and reproducible from the reference installation: it holds the OVMF template plus the `Windows Boot Manager` entry, and no user data;
- in production, nginx forbids proprietary Windows images under `/images/` (`infra/nginx/site.conf`). The in-place middleware only exists in development, so hosting the disk and its NVRAM store is the operator's responsibility.

## Limitations

- UEFI boot through OVMF over an HTTP Range disk is proven up to the Windows 11 **sign-in screen**; the desktop login is still under validation;
- no TPM 2.0 and no Secure Boot database: 24H2 installs and boots only with BitLocker disabled, and some features stay unavailable;
- stdvga/bochs VGA with no GPU acceleration: the desktop is software-rendered and slow;
- ephemeral guest storage: read-only source, guest writes lost on stop (a Windows update or activation may therefore be lost between sessions);
- disk licence, activation state and security are the operator's responsibility.
