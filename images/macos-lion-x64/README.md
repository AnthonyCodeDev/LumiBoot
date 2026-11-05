# macOS Lion x64 (experimental)

An experimental pipeline for an **operator-supplied** Apple macOS Lion 10.7 x64 installer. No Apple
media is versioned, published or redistributed by LumiBoot: the DMG stays outside the repository,
this tooling only writes into the Git-ignored `images/macos-lion-x64/build/`, and no catalogue
profile, engine, manifest or card is added by this directory.

Status, as measured (2026-11-04):

- **Extraction proven** — the real `InstallMacOSX.dmg` was unpacked down to `InstallESD.dmg` with
  7-Zip 26.03, outside the repository.
- **Installer boot proven** — under QEMU 9.2 + OVMF + OpenCore 1.0.8 the Lion installer reaches its
  GUI, « Mac OS X Utilities », and stays there:
  [QEMU installer boot](#qemu-installer-boot-measured-on-2026-11-04).
- **Full installation proven** — `Install Succeeded` in 3192.09 s with 7.52 GiB written to the target
  disk: [Installation](#installation-measured-on-2026-11-04).
- **No LumiBoot support** — no `macos-lion-x64` profile, no `manifest.json`, no published image, no
  catalogue change and **no compatibility claim**. The catalogue entry `macos-sequoia` stays
  `planned` ([`docs/v64.md`](../../docs/v64.md), [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md)).
  Everything below ran outside LumiBoot, under bare QEMU.

## What you must provide

- the Apple installer **`InstallMacOSX.dmg`** (Mac OS X Lion 10.7). It is not downloadable from this
  repository and must never be committed;
- a valid licence for that copy of macOS (see [Licensing](#licensing));
- Node.js 20+ and pnpm 9.14.2;
- **7-Zip** on Windows (26.03 was enough for every container here), `hdiutil` + `pkgutil` on macOS,
  `dmg2img`/`7z` on Linux/WSL;
- for the QEMU probe, `qemu-system-i386` or `qemu-system-x86_64` and an OVMF/edk2 firmware build
  (`edk2-i386-code.fd`/`edk2-x86_64-code.fd` and their `-vars.fd` template).

Nothing is downloaded by the script: it only unpacks the file you point it at.

## What `InstallMacOSX.dmg` contains

The Apple image is a **UDIF** container wrapping an **HFS+** volume. A UDIF ends with a **512-byte
trailer whose first four bytes are `koly`**, at offset `size - 512`; the last four bytes of the file
are the tail of the image-offset field and read `00 00 00 00`, so looking for `koly` in the last four
bytes of the file always fails.

Inside the volume sits a flat package, a **xar** archive. On the real Lion installer the installer
image is a **direct member of that xar**, not a file inside the `Payload`:

```text
InstallMacOSX.dmg                 UDIF (512-byte trailer, `koly` at its offset 0)
└── Install Mac OS X/             HFS+ volume
    └── InstallMacOSX.pkg         xar archive
        ├── InstallESD.dmg        DIRECT xar member: the installer media (UDIF -> HFS+)
        ├── Payload               cpio member (24.9 MB), not needed to reach InstallESD.dmg
        ├── Bom
        ├── Scripts
        └── Distribution

InstallESD.dmg                    UDIF -> HFS+ volume "Mac OS X Install ESD"
├── BaseSystem.dmg                the boot volume of the installer (HFS+)
├── BaseSystem.chunklist
├── boot.efi
├── kernelcache
├── mach_kernel
├── .disk_label
├── Packages/                     OSInstall.mpkg + the payload packages
└── Install Mac OS X Lion.app/
```

The chain is therefore **DMG → `InstallMacOSX.pkg` → `InstallESD.dmg`**. `Payload` is only unpacked as
a fallback: older layouts nest the image inside it, the Lion one does not. 7-Zip decompresses the xar
member itself, so the `Payload` it extracts is already a plain cpio (`070707`), not a gzip stream: the
extractor sniffs the gzip magic, gunzips only when it really is gzip, and treats a missing or
unreadable `Payload` as a warning once `InstallESD.dmg` is found.

`BaseSystem.dmg` is the actual **boot volume** of the installer. `Packages/` holds the payload the
installer copies onto the target; the installer looks for it at `/System/Installation/Packages`,
which is why a bare restored `BaseSystem.dmg` cannot install until that directory is filled.

## Measured on a real Lion installer (2026-11-04)

Source: `InstallMacOSX.dmg`, 4 720 237 409 bytes, SHA-256
`DB0B2300DE719FA3E4EE132B55AFD4E689211AD5332760FE5FE7A30351C9E75C`, extracted on Windows with
**7-Zip 26.03**. `dmg2img` was not needed: `7z` read the UDIF, the HFS+ volume and the xar directly.

| Artefact | Size (bytes) | SHA-256 |
|---|---:|---|
| `dmg/Install Mac OS X/InstallMacOSX.pkg` | 4 732 270 326 | — |
| `pkg/InstallMacOSX.pkg/InstallESD.dmg` | 4 706 314 020 | `CC228EEE66CB8FE12DDC37A047BCFBA863CBF1BD281CE27B92A0B6824541CDC1` |
| `InstallESD.dmg/BaseSystem.dmg` | 462 662 180 | `4CF2407BD5692800117FBE1D5D80FABE8948E0573CB37E46067EF46F3565E2BE` |

`InstallESD.dmg` carries the HFS+ volume **« Mac OS X Install ESD »**, 1 073 files and 144
directories: `BaseSystem.dmg` (462 662 180), `BaseSystem.chunklist` (1 912), `boot.efi` (1 120 944),
`kernelcache` (26 139 502), `mach_kernel` (15 572 704), `.disk_label` (581), `Packages/` (57 files,
4 210 897 982 bytes) and `Install Mac OS X Lion.app/`.

`BaseSystem.dmg` carries the HFS+ volume **« Mac OS X Base System »**, macOS **10.7.5, build 11G63**.
Its `System/Library/CoreServices/boot.efi` and
`System/Library/Caches/com.apple.kext.caches/Startup/kernelcache` are present, and it has **no
`mach_kernel` at the volume root** — the Lion kernel lives in the cache on this image.

Three details matter for the next steps:

- **there is no `BaseSystem.pkg`.** Lion builds its base system from `BaseSystemBinaries.pkg`
  (317 374 067) plus `BaseSystemResources.pkg` (1 539 783). A procedure that waits for a package
  named `BaseSystem.pkg` assumes the Mavericks-and-later layout and will fail here;
- `System/Installation/Packages` inside `BaseSystem.dmg` is a **33-byte symbolic link**. 7-Zip on
  Windows extracts it as a **0-byte file** unless symlink creation is privileged, so its target could
  not be resolved from that extraction. Treat the directory as "must be filled with the `Packages/`
  tree" rather than trusting an extracted copy;
- the xar `Payload` (24 907 776 bytes) comes out of `7z x` as a **plain cpio** starting with
  `070707`, not as a gzip stream: a blind `gunzip` fails with `incorrect header check`. The extractor
  sniffs the gzip magic first; `InstallESD.dmg` never comes from there anyway.

Largest packages in `Packages/`:

| Package | Size (bytes) |
|---|---:|
| `Essentials.pkg` | 1 786 906 857 |
| `AdditionalSpeechVoices.pkg` | 438 288 250 |
| `BaseSystemBinaries.pkg` | 317 374 067 |
| `BSD.pkg` | 215 843 433 |
| `MediaFiles.pkg` | 171 864 585 |
| `iTunes.pkg` | 155 292 386 |
| `OxfordDictionaries.pkg` | 140 444 204 |
| `X11User.pkg` | 59 398 053 |
| `AdditionalEssentials.pkg` | 48 473 193 |
| `Mail.pkg` | 39 957 539 |
| `MigrationAssistant.pkg` | 30 782 020 |
| `BaseSystemResources.pkg` | 1 539 783 |
| `OSInstall.mpkg` | 678 184 |

`OSInstall.pkg` (2 270) and `OSUpgrade.pkg` (854) complete the installer side. The remaining entries
are 21 language packages totalling roughly 400 MB (`French.pkg` is 20 589 753).

## Extraction, per host

The script automates the whole chain on Windows. The manual commands below are the reference
procedure, and the way out when 7-Zip cannot read a container.

### Windows (7-Zip)

```powershell
$source = "D:\Apple\InstallMacOSX.dmg"
$build  = "images\macos-lion-x64\build"

& "C:\Program Files\7-Zip\7z.exe" l $source
& "C:\Program Files\7-Zip\7z.exe" x $source -o"$build\dmg" -y
& "C:\Program Files\7-Zip\7z.exe" x "$build\dmg\Install Mac OS X\InstallMacOSX.pkg" -o"$build\pkg" -y

# InstallESD.dmg is a direct xar member (7-Zip keeps the archive name as a directory):
Get-ChildItem -Recurse "$build\pkg" -Filter InstallESD.dmg | Select-Object FullName, Length

# Optional fallback only. 7-Zip already decompressed the xar member, so Payload is a
# plain cpio here (it starts with "070707"); give it the .cpio hint and extract it.
# Older layouts leave it gzipped: then `7z x Payload.gz` first.
Copy-Item "$build\pkg\InstallMacOSX.pkg\Payload" "$build\pkg\InstallMacOSX.pkg\Payload.cpio"
& "C:\Program Files\7-Zip\7z.exe" x "$build\pkg\InstallMacOSX.pkg\Payload.cpio" -o"$build\payload" -y
```

Equivalent, once: `pnpm assets:macos:extract -- --source "D:\Apple\InstallMacOSX.dmg"`.

### macOS (`hdiutil`, `pkgutil`, `xar`)

```bash
hdiutil attach -noverify -readonly -noautoopen "InstallMacOSX.dmg"
# -> /Volumes/InstallMacOSX

pkgutil --expand "/Volumes/InstallMacOSX/InstallMacOSX.pkg" build/pkg
# 7-Zip instead keeps one level: build/pkg/InstallMacOSX.pkg/
ls -l build/pkg/InstallESD.dmg

# Same result with xar:
#   mkdir -p build/pkg && xar -xf "/Volumes/InstallMacOSX/InstallMacOSX.pkg" -C build/pkg

hdiutil detach "/Volumes/InstallMacOSX"
```

`hdiutil attach` reads the UDIF container natively; nothing needs to be converted first.

### Linux / WSL (`dmg2img`, `7z`, `hfsplus`)

```bash
sudo apt install p7zip-full

7z x InstallMacOSX.dmg -obuild/dmg -y
7z x "build/dmg/Install Mac OS X/InstallMacOSX.pkg" -obuild/pkg -y
find build/pkg -name InstallESD.dmg -printf '%p %s\n'

# Only if 7-Zip refuses the container: convert the UDIF to a raw HFS+ image and mount it.
sudo apt install dmg2img
dmg2img -i InstallMacOSX.dmg -o build/InstallMacOSX.img
mkdir -p /mnt/dmg
sudo mount -t hfsplus -o loop,ro build/InstallMacOSX.img /mnt/dmg
# `hfsplus`/`hfsprogs` provide the driver; the same files are then under /mnt/dmg.
```

Under WSL2 keep the working directory on a native Linux filesystem
(`${XDG_CACHE_HOME:-$HOME/.cache}`), not `/mnt/c`: the extraction relies on file names and modes
that DrvFs does not always preserve.

## A bootable medium, not a renamed ISO

**Renaming `InstallMacOSX.dmg` (or `BaseSystem.dmg`) to `.iso` cannot boot, and neither can
`dmg2img` output renamed the same way.** Reasons, in order:

1. a UDIF is not a filesystem: it is a container of (usually compressed) chunks, described by a
   512-byte `koly` trailer at the very end, and only a UDIF reader can turn it into a volume;
2. an ISO 9660 image carries a different structure: a primary volume descriptor at sector 16 and an
   El-Torito boot record with a boot catalog. A DMG has neither, so the firmware finds **no boot
   entry point**;
3. macOS Lion boots through the HFS+ volume itself: the firmware reads
   `/System/Library/CoreServices/boot.efi` from the **HFS+** volume. OVMF and SeaBIOS have **no HFS+
   driver**, so even a raw HFS+ volume attached as a disk is not readable by the firmware;
4. Lion's `boot.efi` is a proprietary two-slice container (x86_64 PE32+ and i386 PE32), not a plain
   EFI application: a standard EDK2 firmware refuses it with `EFI_UNSUPPORTED`, and each extracted
   slice stops at `Can not initialize console` — see
   [QEMU probe, measured on 2026-11-04](#qemu-probe-measured-on-2026-11-04).

The real procedures are:

- **restore `BaseSystem.dmg` onto a writable HFS+ volume**, then copy `Packages/` in. On macOS this
  is `asr` and `cp`:

  ```bash
  hdiutil create -size 8g -fs HFS+ -volname "Lion Installer" build/installer.dmg
  hdiutil attach build/installer.dmg
  hdiutil attach -noverify -readonly "build/pkg/InstallESD.dmg"
  asr restore --source "/Volumes/Mac OS X Install ESD/BaseSystem.dmg" \
              --target "/Volumes/Lion Installer" --erase --noverify
  rm -f "/Volumes/Lion Installer/System/Installation/Packages"
  cp -R "/Volumes/Mac OS X Install ESD/Packages" "/Volumes/Lion Installer/System/Installation/Packages"
  hdiutil detach "/Volumes/Lion Installer"
  ```

  The result is an HFS+ disk image with a real `boot.efi`, which is the medium a hypervisor can
  attach. On Linux the same volume can be prepared with `hfsplus`/`hfsprogs` (`mkfs.hfsplus`, loop
  mount) instead of `asr`; on Windows there is no HFS+ writer, so prepare the volume elsewhere and
  copy the resulting image back;
- **`createinstallmedia`** performs the same restore and `Packages` copy on a USB volume, but it
  only exists from **Mavericks (10.9)** onward. Lion predates it, so for Lion the `asr` path above is
  the applicable one.

Neither produces an ISO. The medium is an HFS+ **disk image**, attached as a disk, and the boot step
still needs a loader that can read HFS+ (for instance a small FAT ESP with Clover/OpenCore
chain-loading `\System\Library\CoreServices\boot.efi`). That boot step was measured on 2026-11-04 in
bare QEMU with OpenCore 1.0.8 — see
[QEMU installer boot](#qemu-installer-boot-measured-on-2026-11-04) — and remains unsolved **inside
LumiBoot**, where no loader environment exists.

## Validation with QEMU

A first probe loaded Apple's `boot.efi` **directly** from the firmware, with no chain-loader, and
recorded a **failure, not a boot**: see
[QEMU probe, measured on 2026-11-04](#qemu-probe-measured-on-2026-11-04). Apple's `boot.efi` is a
proprietary container with two slices (x86_64 PE32+ and i386 PE32), so a standard EDK2 firmware
refuses it and neither firmware family gets past its console initialisation: the i386 firmware is the
one that could host the 32-bit slice, the x86_64 firmware the 64-bit one, and both must be tried.
This is not a supported configuration. A second probe, with OpenCore as the chain-loader, booted the
installer and is recorded in
[QEMU installer boot](#qemu-installer-boot-measured-on-2026-11-04).

```bash
# Trial A: 32-bit firmware, legacy PC machine, IDE storage (the measured layout).
qemu-system-i386 \
  -machine pc \
  -m 2048 \
  -cpu Penryn \
  -smp 2 \
  -drive if=pflash,format=raw,readonly=on,file=edk2-i386-code.fd \
  -drive if=pflash,format=raw,file=edk2-i386-vars.fd \
  -drive file=base.raw,format=raw,index=0,media=disk \
  -drive file=InstallESD.dmg,format=raw,index=1,media=disk \
  -drive file=target.qcow2,format=qcow2,index=2,media=disk \
  -snapshot -vga std -nic none
```

```bash
# Trial B: 64-bit firmware, Q35 + ICH9 AHCI (the layout LumiBoot's v64 profiles declare).
qemu-system-x86_64 \
  -machine q35 -m 2048 -cpu Penryn -smp 2 \
  -drive if=pflash,format=raw,readonly=on,file=edk2-x86_64-code.fd \
  -drive if=pflash,format=raw,file=uefi-vars.fd \
  -device ich9-ahci,id=sata \
  -drive id=installer,file=InstallESD.dmg,format=raw,if=none \
  -device ide-hd,drive=installer,bus=sata.0 \
  -snapshot -vga std -nic none
```

- **`-snapshot` instead of `readonly=on` on the disks**: QEMU 9.2 refuses a read-only IDE drive
  (`qemu.exe: Block node is read-only`), including through `-device ide-hd`, so the Apple files are
  kept unmodified by writing to a temporary overlay instead. `readonly=on` stays valid on the pflash
  code image, which is not an IDE drive;
- **`q35`** matches the chipset family the LumiBoot v64 profiles declare (`v64Machine: q35`) and
  gives ICH9 AHCI, the only storage controller a Lion installer knows out of the box;
- **OVMF/edk2** provides the UEFI firmware; `boot.efi` is a UEFI application, so a BIOS-only boot
  does not even reach it (trial C);
- **`-cpu Penryn`** is the safest Core 2 profile for Lion; `-cpu Haswell` changes the CPUID surface
  and some 10.7 builds panic earlier. Neither is an Apple CPU model;
- **HFS+ only**: Lion predates APFS (macOS 10.13) and ships no NVMe driver, so an HFS+ volume on AHCI
  is the only realistic layout. That part is in Lion's favour;
- **no SMC**: QEMU may offer an `applesmc` device in some builds (`-device applesmc`), but nothing
  here depends on it. Without SMC the `AppleSMC` kext does not attach, and firmware/installer checks
  that read SMC keys are unproven;
- **no `AppleSMBIOS`**: PC DMI tables are not Apple's. A `-smbios type=1` override only changes the
  strings the firmware reports (`manufacturer=Apple Inc.`, `product=MacPro5,1`); the platform expert
  still sees a generic PC;
- **no Apple CPUID leaves or MSRs**: the model, platform and frequency leaves Apple's kernel reads
  are not modelled;
- **no NVMe/APFS, no TPM, no Secure Boot**: not needed by Lion (it predates all three), and not
  provided anywhere; Secure Boot is out of scope for this pipeline;
- **licensing**: the Apple licence restricts running macOS to Apple-branded hardware. Emulation does
  not lift that restriction (see [Licensing](#licensing)).

The first probe stopped long before any of the SMC, SMBIOS or CPUID items could matter: it recorded a
stop inside Apple's own loader, well before any kernel read. The next section gives the eight trials,
the exact messages, and what they do — and do not — prove. **No compatibility is promised**, and no
result recorded outside this repository would change the catalogue.

## QEMU probe, measured on 2026-11-04

Eight bounded trials, none of which hung. QEMU **9.2.0** with OVMF/edk2, a BaseSystem disk (APM, an
`Apple_HFS` partition at `0x9000`), `InstallESD.dmg` as a second disk and a 20 GiB sparse qcow2 target.
Screen figures are the mean luminance of the VGA canvas and its share of non-black pixels.

| Trial | Firmware / machine / storage | Duration | Result | Screen |
|---|---|---|---:|---|---|
| **A** | OVMF **i386**, `-M pc`, IDE | 250 s | `UEFI Interactive Shell v2.2`; `BLK0`, `BLK1`, `BLK2` on `Pci(0x1,0x1)/Ata(0x0)`; **no `FS0:`** | 1.54/255, 0.88 % non-black |
| **B** | OVMF **x86_64**, `-M q35`, AHCI | — | Same shell; the disks show up on `Sata(0x0,0xFFFF,0x0)`; **no `FS0:`** | 1.73/255, 1.00 % non-black |
| **C** | **SeaBIOS**, `-M pc`, IDE | 70 s | `Boot failed: not a bootable disk` → `could not read the boot disk` → `Could not read from CDROM (code 0003)` → iPXE → `No bootable device.` | — |
| **D** | OVMF x64 + FAT ESP holding Apple's `boot.efi` | — | `FS0:` mounts, but there is **no autoboot** | — |
| **E** | OVMF x64, `FS0:\> efi\boot\bootx64.efi` | — | `Command Error Status: Unsupported` — `LoadImage` refuses the Apple container | — |
| **F** | Extracted **x86_64** slice, bare | — | `Can not initialize console` / `sleeping 10 seconds before exit...`, then back to the shell | — |
| **G** | Extracted **i386** slice, bare | — | Identical to F | — |
| **H** | OVMF x64, 20 GiB disk with BaseSystem at offset 0, `-cpu Penryn` | — | Identical to B: no `FS0:`, same shell | 1.73/255 |

`qemu.log` stayed empty for all eight trials. With `-d guest_errors` the only entries were three
rejected MMIO reads:

| Trace (`qemu-trace.log`, the whole file — not versioned) | Address | Meaning |
|---|---|---|
| Rejected MMIO read | `0xFED40000` | OVMF TPM probe (no TPM present) |
| Rejected MMIO read | `0xFED40030` | same probe |
| Rejected MMIO read | `0xFED40014` | same probe |

They have no effect on the boot.

Apple's `boot.efi` was measured as a **proprietary multi-architecture container**, not a plain EFI
application: magic `0x0EF1FAB9` (little-endian), two slices whose sizes add up exactly to the file.

| Slice | Format | Machine | Offset | Size (bytes) |
|---|---|---|---:|---:|
| 1 | PE32+ | `0x8664` (x86_64) | `0x30` | 576 576 |
| 2 | PE32 | `0x14C` (i386) | `0x8CC70` | 544 320 |
| — | whole file | — | — | 1 120 944 |

A standard EDK2 firmware has no loader for that container, which is why trial E returns
`EFI_UNSUPPORTED`. Extracting a slice and loading it by hand gets further, and stops at console
initialisation.

### Why it stops, in order

| # | Statement | Status |
|---|---|---|
| 1 | A BIOS boot of the media fails: not a bootable disk, the CD-ROM cannot be read, iPXE finds nothing (C) | proven by the probe |
| 2 | OVMF has **no HFS+ driver**: the `Apple_HFS` partitions appear only as `BLK0/BLK1/BLK2` (ATA) or `Sata(0x0,…)` (AHCI), never as `FS0:`, so `boot.efi` is never loaded from the volume (A, B, H) | proven by the probe |
| 3 | Apple's `boot.efi` is a proprietary container: `LoadImage` returns `EFI_UNSUPPORTED` (E) | proven by the probe |
| 4 | Even extracted, a slice loads and stops at console initialisation: `Can not initialize console`, `sleeping 10 seconds before exit...`, back to the shell (F, G) | proven by the probe |
| 5 | `PlatformSupport.plist`, the absent SMC, the storage controller and the kernel bitness | **not reached, therefore not proven** |

The stop point is therefore the console initialisation of `boot.efi`, **before any read of
`mach_kernel` or `kernelcache`**. Nothing in the probe says anything about the SMC, the SMBIOS model,
the AHCI path or the kernel bitness: those remain untested hypotheses, and are listed as such below.

## QEMU installer boot, measured on 2026-11-04

A second probe replaced the direct `boot.efi` load with a **chain-loader**: OpenCore 1.0.8 on a FAT32
ESP, which reads the HFS+ BaseSystem volume and hands over to Apple's `boot.efi`. QEMU **9.2.0**,
TCG (no KVM), outside LumiBoot.

| Item | Measured value |
|---|---|
| Machine | `-M q35 -m 2048 -smp 1 -cpu Penryn -vga std` |
| Firmware | OVMF `edk2-x86_64-code.fd` |
| Disk 0 | `esp-oc.img`, FAT32 ESP holding OpenCore 1.0.8 |
| Disk 1 | `basesystem-hfs.img`, the restored HFS+ BaseSystem volume |
| Disk 2 | install target |
| Drivers | `OpenRuntime.efi` + **`HfsPlusLegacy.efi`** |

`HfsPlusLegacy.efi` is mandatory here: `-cpu Penryn` has no **RDRAND**, and `HfsPlus.efi` executes an
unsupported instruction and dies with `#UD` before the volume is mounted.

OpenCore settings that were needed (`config.plist`):

| Key | Value |
|---|---|
| `Booter > Quirks > ProvideConsoleGop` | `true` |
| `Booter > Quirks > FixupAppleEfiImages` | `true` |
| `Booter > Quirks > EnableWriteUnprotector` | `true` |
| `Booter > Quirks > AllowRelocationBlock` | `true` — see blocker 1 |
| `Kernel > Emulate > DummyPowerManagement` | `true` |
| `Kernel > Quirks > AppleCpuPmCfgLock` | `true` |
| `Kernel > Quirks > KernelArch` | `i386` |
| `Misc > Security > ScanPolicy` | `0` |
| SMBIOS | `MacBookPro5,1`, board-id `Mac-F42D86C8` |
| `boot-args` | `-v -no_compat_check keepsyms=1 debug=0x100` |

The SMBIOS values are loader inputs, not an Apple hardware emulation: they only change the strings
OpenCore presents to `boot.efi`.

### Blocker 1 — fixed-address kernel load refused by the OVMF memory map

```text
Error allocating 0x83 pages at 0x800000 alloc type 2
Loading 'mach_kernel'...
Could not open file 'mach_kernel'
Error loading kernel 'mach_kernel' (0xe)
OCB: StartImage failed - Aborted
```

Two independent causes:

- Lion **predates KASLR**: its `boot.efi` loads the kernel at a **fixed address**, which the OVMF
  memory map does not leave free. `Booter > Quirks > AllowRelocationBlock=true` gives the loader a
  relocatable block and clears the failure;
- `mach_kernel` is **absent from the BaseSystem** volume — the Lion kernel lives in the `kernelcache`,
  which is why the `Could not open file` line is expected and does not by itself block the boot.

The kexts were not the cause: a control run with `Kernel > Add = []` produced the same error.

With `AllowRelocationBlock=true` the installer reaches the **GUI**, « Mac OS X Utilities », at about
**90 s**, remains up for **1200 s**, and the VGA canvas measures **144.81/255** mean luminance with
**99.2 %** non-black pixels.

### Blocker 2 — VirtualSMC on 10.7

```text
Lilu api: @ automatically disabling VirtualSMC (138) on an unsupported operating system
```

Lilu disables VirtualSMC on 10.7, so the kext is inoperative there. It was removed from the ESP before
the installation run; the SMC was provided by QEMU instead (see
[Installation](#installation-measured-on-2026-11-04)).

### The picker needs a keystroke, not a timeout

The OpenCore picker does **not** honour `Misc > Boot > Timeout`: the countdown stays frozen and the
log repeats `OCM: Failed to start image - Already started`. The boot proceeds only after a real key is
delivered — `down` then `ret` through the PS/2 `send-key` monitor command, 5–6 s after the picker
appears.

### Which slice runs

OVMF x64 executes the **x86_64** slice of Apple's `boot.efi`, and that loader then loads an **i386**
kernel, which is what `KernelArch=i386` selects. Firmware bitness and kernel bitness are therefore
independent, and on x64 firmware the i386 slice is never used.

## Installation, measured on 2026-11-04

Same machine as above, with the two fixes added:

- **SMC**: `-device isa-applesmc,osk="ourhardworkbythesewordsguardedpleasedontsteal(c)AppleComputerInc"`.
  `ioreg` then lists `AppleSMC` with `smc-version = 1.13f3`; Lilu and VirtualSMC were removed from the
  ESP beforehand.
- **Language**: `prev-lang:kbd = en:0`, which yields the English installer UI.

### `Packages` has to be resolved, and Lion does not do it here

`System/Installation/Packages` on the BaseSystem volume is a **33-byte symlink** to
`/System/Installation/PackagesLink`. That link is normally created at boot by `CDIS/mountrecursive`,
and **only** when the boot medium is a DMG mounted inside a volume; with the HFS+ volume attached as a
plain disk the target was missing, so the installer found no payload.

The measured workaround is a **149-byte patch of `/etc/rc.cdrom`**, rewritten with the same length and
the same byte offsets, inside a **copy** of the BaseSystem (`basesystem-util.img`); that script now
runs:

```sh
ln -sfn "/Volumes/Mac OS X Install ESD/Packages" /System/Installation/PackagesLink
```

The installer then sees `OSInstall.mpkg` (678 184 bytes) and **57 packages**.

### Result

| Measurement | Value |
|---|---|
| Final status | `Install Succeeded` |
| Installation time | 3192.09 s (3222.84 s total, including the boot to the GUI) |
| Written to the target | 7.52 GiB |
| Read from the ESD | 4.90 GiB (QEMU blockstats) |
| Recovery HD | created and started |

Two limits were measured on the installed system:

- **`boot.efi` is absent from the target** after the installation and must be copied back from the
  ESD before the disk is bootable;
- the **first boot of the installed system panics** with `KernelArch=i386`:

  ```text
  Unable to find driver for this platform: "ACPI"
  Boot args: arch=i386
  ```

  The installed `kernelcache` is x86_64, so the expected fix is `KernelArch=x86_64`. It is **under
  validation**: this README does not record it as proven, and no boot of the installed system is
  claimed.

## v64 feasibility, measured on 2026-11-04

Three checks, all outside LumiBoot's shipping configuration:

**1. A 32-bit kernel with PAE boots under v64.** An Ubuntu 18.04 `vmlinuz-686`
(`CONFIG_X86_PAE=y`) was run in the v64 engine with `cpu_type: "x86_64"`, 512 MiB and one core. It
reaches a full userspace: `uname -m` prints `i686`, `/proc/cpuinfo` lists `pae`, and the guest marker
`LUMIBOOT_PAE_i686` appears at **70.7 s** (three runs: 75.1 / 78.7 / 70.7 s), with no panic. The
x86_64 control (Alpine) prints its marker at **20.4 s** on the same setup. So the 32-bit kernel path
is not a blocker by itself; the i386 kernel Lion would load is a PAE-less 10.7 kernel and was not
tried.

**2. The injected initrd is capped at 64 MiB.** `libv86.mjs` fixes the injected initrd size at
**64 MiB**; any kernel whose decompressed image grows past that overwrites it. This is the same
constraint already recorded for Fedora in [`docs/v64.md`](../../docs/v64.md).

**3. `hdb` is available in the engine but not exposed.** Code analysis only: `V64Options` declares
`hda` and `cdrom` (`runtime.ts:62-67`) while the engine accepts `hdb` (`libv86.mjs:446`). A second
disk — the shape an ESP + installer pair needs — therefore requires a type-level change, not a new
device. Separately, the OVMF shipped with v64 is **byte-identical** to QEMU's: `ovmf-code.fd` sha256
`33090cc0…`, vars `5d2ac383…`. `AllowRelocationBlock` is an OpenCore setting, so blocker 1 needs **no
engine modification** at all.

None of this makes macOS bootable in LumiBoot: the Mach-O `boot.efi` container, the Apple kexts and
the HFS+ handover inside the browser engine were not tested. The catalogue is unchanged.

## What is missing on the v64 side

The v64 engine boots Linux and Windows 11 today ([`docs/v64.md`](../../docs/v64.md)). For macOS, the
list below is ordered by what the v64 probe actually established: only the first line is measured,
the others are documented hypotheses that the probe never reached. The bare-QEMU installation above
did exercise a QEMU SMC device, an SMBIOS model and ICH9 AHCI — but in QEMU, not in v64, so none of
those lines changes status here.

| # | Missing piece | Why it blocks a macOS guest | Evidence |
|---|---|---|---|
| **1** | **HFS+ reader and Apple `boot.efi` handover** | v64 exposes no HFS+ volume to the firmware and no loader environment for Apple's container: the probe shows OVMF seeing `Apple_HFS` only as `BLK*` and refusing the container with `EFI_UNSUPPORTED`. Outside v64, a FAT32 ESP with OpenCore 1.0.8 + `HfsPlusLegacy.efi` closes the gap entirely | **measured blocker** |
| 2 | Apple SMBIOS/DMI model | No model injection: the kernel and the installer would see a generic PC, not a Mac | documented hypothesis |
| 3 | SMC | No AppleSMC device, so `AppleSMC` does not attach and SMC-dependent checks are unproven | documented hypothesis |
| 4 | Extended Apple CPUID | Only the leaves recorded in `docs/v64.md` (`0x8000_0001`, `0x8000_0007`, `0x8000_0008`) are served; Apple's model/platform/frequency surface is not emulated | documented hypothesis |
| 5 | AHCI/ICH9 for macOS | The controller exists and boots Windows 11 (`storahci`), but it has never carried an Apple kext | documented hypothesis |
| 6 | TPM 2.0 / Secure Boot | Out of scope: Lion needs neither, and v64 exposes neither | out of scope |
| 7 | Rendering | Bochs VGA / VirtIO-GPU only, no Apple framebuffer driver: no QE/CI, no acceleration | documented hypothesis |

Until at least line 1 is answered, macOS stays out of the catalogue; the other lines cannot even be
evaluated before it, because the guest never reaches the code that would exercise them.

## Validation checklist

Order matters; each line is a prerequisite for the next one, and none is optional.

- [x] **Extraction** — done on 2026-11-04 with 7-Zip 26.03 on the real installer:
      `InstallESD.dmg` is 4 706 314 020 bytes,
      SHA-256 `CC228EEE66CB8FE12DDC37A047BCFBA863CBF1BD281CE27B92A0B6824541CDC1`, and
      `pnpm assets:macos:check` reproduces size and hash without writing anything.
- [x] **Boot medium** — done on 2026-11-04. The BaseSystem HFS+ volume was restored to a writable
      image (`basesystem-hfs.img`) and attached as disk 1 behind a FAT32 ESP (`esp-oc.img`, disk 0)
      holding OpenCore 1.0.8 with `OpenRuntime.efi` + `HfsPlusLegacy.efi`; the install target was
      disk 2. The installer GUI was reached at about 90 s. `Packages` had to be resolved by the
      patched `/etc/rc.cdrom` of `basesystem-util.img` — see
      [Installation](#installation-measured-on-2026-11-04).
- [x] **QEMU probe** — done on 2026-11-04, in two stages. Stage 1, loading Apple's `boot.efi`
      directly, is a **recorded failure, not a boot**: no `FS0:` in either firmware (A, B, H),
      `EFI_UNSUPPORTED` on Apple's container (E), and `Can not initialize console` for each extracted
      slice (F, G). Stage 2, with OpenCore as the chain-loader, **boots the installer** and completes
      an installation: [QEMU installer boot](#qemu-installer-boot-measured-on-2026-11-04),
      [Installation](#installation-measured-on-2026-11-04).
- [ ] **v64 gap analysis — partial** — two obstacles are now measured, not hypothetical: the 32-bit
      kernel path (a PAE i686 Linux kernel boots in v64 to a full userspace) and the missing second
      disk (`hdb` exists in the engine, `runtime.ts:62-67` does not expose it). The OVMF shipped by
      v64 is byte-identical to QEMU's, so `AllowRelocationBlock` needs no engine change. Still
      untested: the Mach-O `boot.efi` container loaded by v64's firmware, Apple's kexts, and the HFS+
      handover. Line 1 of the gap table is still not answered inside v64.
- [ ] **Catalogue profile, only then** — `images.ts`, `profiles.ts` and the docs, in a separate
      change. `validated: true` is set **only** after a real boot recorded in this file and in
      [`docs/v64.md`](../../docs/v64.md), and is reverted as soon as a rebuild stops matching. No
      profile exists today, and the installer boot above happened **outside LumiBoot**.

## Licensing

macOS is licensed by Apple for use on **Apple-branded hardware** only. Emulating a PC does not lift
that restriction, and no extraction step changes it. The media, the licence and the legality of what
you run are the **operator's responsibility**; LumiBoot neither distributes Apple media nor
provides a licence, a key or a download link. Terms: [`docs/LICENSES.md`](../../docs/LICENSES.md).

## Commands

```bash
# Full extraction: DMG -> InstallMacOSX.pkg -> InstallESD.dmg
pnpm assets:macos:extract -- --source "<path>\InstallMacOSX.dmg"

# Verify an already extracted tree (nothing is written; prints size + SHA-256)
pnpm assets:macos:check

# Variants
pnpm assets:macos:extract -- --source "<path>\InstallMacOSX.dmg" --out "D:\build\macos-lion"
pnpm assets:macos:extract -- --source "<path>\InstallMacOSX.dmg" --force
pnpm assets:macos:extract -- --check --json
```

`--out` defaults to `images/macos-lion-x64/build`, which is Git-ignored. `--force` is required to
write into a non-empty directory. `--check` requires only `InstallESD.dmg` (under `pkg/`, or under
`payload/` for older layouts): the source DMG is never copied by the extractor, so it is optional and
only mentioned when a copy happens to be present. 7-Zip is resolved from `PATH`, then
`C:\Program Files\7-Zip\7z.exe`, then `C:\Program Files (x86)\7-Zip\7z.exe`, then `$SEVEN_ZIP`;
without any of them the script stops with the per-host commands instead of guessing.

Extracted layout:

```text
images/macos-lion-x64/build/
├── dmg/Install Mac OS X/InstallMacOSX.pkg   the DMG member (xar)
├── pkg/InstallMacOSX.pkg/InstallESD.dmg     the installer media — what the next step consumes
├── pkg/InstallMacOSX.pkg/Payload.cpio       only when the fallback path ran
├── payload/                                 only for older layouts that nest InstallESD.dmg
└── …                                        the HFS+ install medium you build stays here too
```
