# macOS Lion x64

A measured pipeline and a **working LumiBoot profile** for an **operator-supplied** Apple macOS Lion
10.7 x64 installation. No Apple
media is versioned, published or redistributed by LumiBoot: the DMG stays outside the repository,
this tooling only writes into the Git-ignored `images/macos-lion-x64/build/`, and the catalogue
profile only references the two local media described under
[Publishing locally](#publishing-locally).

Status, as measured (installer 2026-11-04, desktop 2026-11-08, v64 2026-11-09 to 2026-11-11):

- **Extraction proven** — the real `InstallMacOSX.dmg` was unpacked down to `InstallESD.dmg` with
  7-Zip 26.03, outside the repository.
- **Installer boot proven** — under QEMU 9.2 + OVMF + OpenCore 1.0.8 the Lion installer reaches its
  GUI, « Mac OS X Utilities », and stays there:
  [QEMU installer boot](#qemu-installer-boot-measured-on-2026-11-04).
- **Full installation proven** — `Install Succeeded` in 3192.09 s with 7.52 GiB written to the target
  disk: [Installation](#installation-measured-on-2026-11-04).
- **Desktop reached under QEMU** — on 2026-11-08 the *installed* volume boots to the Lion login window
  and then the full desktop, still under bare QEMU 9.2/TCG + OpenCore, outside LumiBoot:
  [Desktop reached](#desktop-reached-measured-on-2026-11-08). It does not change the status below.
- **v64 engine probed — kernel, DSMOS, the Lion login window, then the desktop** — on 2026-11-09 an
  ad-hoc Playwright harness **outside this repository** drove the v64 engine to the OpenCore picker,
  loaded `boot.efi`, read the whole kernelcache and, with a **three-kext injection** in the ESP, passed
  the `Waiting for DSMOS...` stop (`DSMOS has arrived`, t ≈ 213 s and 228 s on two runs). On 2026-11-10,
  with the installed volume **decontaminated** (the same `.disabled` renames that fixed the white
  screen under QEMU), the engine paints the **Lion login window in 249 s** — **201 s** on the second
  boot, with **no reset** and a 62 170-byte `system.log`:
  [Login window reached](#login-window-reached--the-decontamination-fix). Input was the wall: macOS has
  **no PS/2 kext** in this volume and v64 exposed no usable USB HID, so the login was displayed but
  could not be passed. On **2026-11-11** that wall is down, **still inside the engine and still
  through that outside-the-repository harness**: the engine now carries a **USB HID boot keyboard**
  (`scripts/patches/v64-usb-keyboard.patch`) and a USB tablet, auto-login opens the session, and the
  **Lion Finder desktop** is painted — menu bar, Dock, Terminal — with keystrokes and pointer events
  reaching the guest: [Desktop, keyboard and mouse in v64](#desktop-keyboard-and-mouse-in-v64).
- **Booted inside LumiBoot** — on 2026-11-11 the product itself boots this pair: the `macos-lion-x64`
  catalogue profile (v64 + OVMF, the local OpenCore ESP, 2048 MiB, the engine's emulated Apple SMC and
  USB HID input) reaches a painted and stable **Lion desktop 245.0 s** after the Start click,
  recorded by `tests/e2e/macos-lion-desktop.spec.ts` with the capture
  [`bureau-lumiboot-245s.png`](bureau-lumiboot-245s.png) (Dock, Andromeda wallpaper, session `lumi`):
  [Booted inside LumiBoot](#booted-inside-lumiboot-measured-on-2026-11-11). The catalogue entry is
  therefore `validated: true`.
- **No distributed media, licence unchanged** — this remains a **local, operator-side** asset: no
  Apple media is published, nothing is redistributed, the installed volume is Git-ignored and cannot
  ship. The Apple licence still restricts macOS to Apple-branded hardware, and LumiBoot claims no
  Apple-hardware compatibility. `macos-sequoia` (Apple Silicon) stays `planned` as an explicit
  **roadmap entry**: it needs the separate ARM64 engine, which is not integrated — a missing engine
  on the LumiBoot side, not a macOS limitation ([`docs/systems.md`](../../docs/systems.md),
  [`docs/v64.md`](../../docs/v64.md)).

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
[QEMU installer boot](#qemu-installer-boot-measured-on-2026-11-04). Inside the **v64 engine** the
same handover was measured on 2026-11-09 through an external harness — see
[Inside v64](#inside-v64-measured-on-2026-11-09) — and, since 2026-11-11, directly in LumiBoot with
the `macos-lion-x64` profile: see
[Booted inside LumiBoot](#booted-inside-lumiboot-measured-on-2026-11-11).

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

  The installed `kernelcache` is x86_64, so the fix was `KernelArch=x86_64`; the 2026-11-08 run boots
  with it and reaches the desktop — see
  [Desktop reached](#desktop-reached-measured-on-2026-11-08). The panic above was measured with
  `KernelArch=i386` and did not recur.

## Desktop reached, measured on 2026-11-08

The **installed** Lion 10.7.5 volume now boots to the **login window** (user `Lumi`) and then the
full **Lion desktop**: menu bar, Dock, the « Welcome to Lion » iCloud window and the keyboard setup
assistant. That run was **bare QEMU 9.2 with TCG, outside LumiBoot**; the browser-engine boot and the
LumiBoot boot came later ([Inside v64](#inside-v64-measured-on-2026-11-09),
[Booted inside LumiBoot](#booted-inside-lumiboot-measured-on-2026-11-11)) and no compatibility claim
follows from the QEMU run.

Captures, taken on the operator's machine outside this repository (not versioned):
`out/T05_boot/ui_desktop3.png` (desktop) and `out/T06_boot/ui_login.png` (login window).

### Recipe

The loader is the one measured on 2026-11-04, now chain-loading the **installed** volume instead of
the BaseSystem:

| Item | Measured value |
|---|---|
| Machine | `-M q35 -smp 1 -cpu Penryn -vga std`, TCG (no KVM) |
| Firmware | OVMF `edk2-x86_64-code.fd` |
| Disk 0 | FAT32 ESP holding OpenCore 1.0.8 |
| Disk 1 | the installed Lion 10.7.5 volume (HFS+) |
| Drivers | `OpenRuntime.efi` + **`HfsPlusLegacy.efi`** |
| Quirks | `Booter > Quirks > AllowRelocationBlock` and `ProvideConsoleGop` `true` |
| SMBIOS | `MacBookPro5,1`, board-id `Mac-F42D86C8` |
| Picker | a real key — `down` then `ret`, no timeout |
| `boot-args` | `debug=0x8` |
| SMC | **FakeSMC 5.3.901**, and the QEMU SMC device is **absent** (see below) |
| Input | `-device usb-kbd` attached at boot; the login window is reached with it |

`HfsPlusLegacy.efi` stays mandatory (`-cpu Penryn` has no `RDRAND`, and `HfsPlus.efi` dies with
`#UD`). `ProvideConsoleGop` and `AllowRelocationBlock` are still needed for the same reasons as on
the installer, and the picker still ignores its timeout.

The SMC is now provided by **FakeSMC 5.3.901** (HWSensors 5.3.901, **thin x86_64**, binary SHA-256
`4EAEF0B1…`), installed as a plain kext in `/System/Library/Extensions`. It must own the SMC alone:
with the QEMU device still present it refuses with
`SMC device detected, will not create another one`, so the run script passes
`--no-smc` (no `-device isa-applesmc` on the QEMU command line). It then logs
`SMC: successfully initialized`.

### FakeSMC: installed vs injected

- **Installed in `/System/Library/Extensions` it works**: FakeSMC 5.3.901 on the QEMU **overlay**
  disk is what logged `SMC: successfully initialized` and reached the desktop in 55 s.
- **Injected by OpenCore, 3.5.6 fails**, for a structural reason measured in v64:

  ```text
  OCAK: Failed to patch symbol __ZN9IOService15configureReportEP19IOReportChannelListjPvS2_
        for vtable __ZTV13FakeSMCDevice
  OCAK: Vtable patching failed for kext org.netkas.FakeSMC
  OC:   Prelinked injection FakeSMC.kext (...) - Invalid Parameter
  ```

  `IOService::configureReport` / `IOReport` **do not exist in Lion** (0 occurrence in `mach_kernel`),
  so the vtable patch cannot succeed; `kxld` adds its own rejection (`LC_SOURCE_VERSION = 42`).
- **5.3.901 does not hit that wall and does inject**: its binary carries neither the
  `configureReport`/`IOReport` reference nor `LC_SOURCE_VERSION`, and it loads from an ESP —
  measured on 2026-11-09, see [DSMOS passed](#dsmos-passed--the-three-kext-injection).
- **Consequence (2026-11-04 layout)**: the base `installer-hfs.img` shipped and tested contains **no
  FakeSMC at all** (183 kexts, kernelcache without it): the QEMU overlay disk is the one that had it.
  The v64 runs instead use a dedicated injection ESP (`esp-fsmc9.img`), not a disk image.

### Why it was white before

Two independent defects, each with its own evidence: the SMC device cost about **six minutes** of the
boot, and the **launchd/`rc.cdrom` environment caused the white screen** itself.

**1. The SMC device — six minutes lost, not a hang.** `isa-applesmc` alone is not enough for Lion: it
falls back to the legacy path,

```text
MMIO regMap == NULL - fall back to old SMC mode
$Num / #KEY / NTK / DPLM / MSDS
```

and the boot then waits on `ACPI_SMC_PlatformPlugin … timed out` at about **300 s**, with
`DSMOS has arrived` only around **400 s** — roughly **6 minutes** of the boot. FakeSMC 5.3.901
removes that wait: a single-user boot completes in **55 s**.

The version matters, and the rejection of FakeSMC **3.5.6** is now explained: its Mach-O carries
`LC_SOURCE_VERSION = 42` (`0x2A`), exactly the value the kernel reports as
`Invalid segment type in MH_KEXT_BUNDLE kext: 42`. That kext can never load on 10.7; 5.3.901 can.

**2. The launchd/CD-ROM environment — the actual white screen.** The system was booting in the
**CD/installation** environment. `/bin/launchctl` contains the literals `/etc/rc.cdrom` and
`multiuser` and runs that script at boot, and **its mere presence** was enough: the file had been
copied from the BaseSystem by the `cp -Rnp *` of the manual install. Deleting
`com.apple.install.cd.plist` changed nothing, because the trigger is the script, not the plist.

With `rc.cdrom` present, `/` stayed **read-only**, `launchctl` could not write `overrides.plist`
(`Socket is not connected`), and therefore **no daemon started at all**: no `syslogd`, no
`WindowServer`, just the framebuffer. The screen was white because nothing was drawing on it.

The fix is a reversible rename to `.disabled`:

| Disabled | Note |
|---|---|
| `/etc/rc.cdrom` | the trigger; absent from every Lion package BOM |
| `/etc/rc.cdrom.orig2` | same script, second copy |
| `/etc/rc.install.orig` | installation path |
| `/etc/rc.imaging` | imaging path |
| `/System/Installation` | installation payload directory |

`/etc/rc.netboot` is **kept**: it is a normal member of `Essentials.bom`. `rc.cdrom` appears in no
Lion package BOM, which is what makes its removal safe.

After the rename, the root mounts `rw`, `overrides.plist` is created (415 bytes) and the system boots
normally.

### What the boot shows

| Measurement | Value |
|---|---|
| `launchd` jobs | **225** |
| `syslogd` | PID **15** |
| `kextd` | running |
| `WindowServer` | PID **82** |
| `loginwindow` | PID **41** |
| `windowserver.log` | 4 966 bytes |
| `system.log` | 38 301 bytes (0 bytes before the fix) |
| Kexts | FakeSMC **901** and `IOGraphicsFamily` loaded |
| Root filesystem | `rw`, `overrides.plist` created (415 bytes) |
| `fsck_hfs -fy` | `The volume Lion appears to be OK` |

`kextcache` run from single-user is a **no-op** on this volume: the cache stays at 26 135 419 bytes,
unchanged. It is `kextd` that rebuilds it at the first successful boot — 20 039 047 bytes afterwards.

The disk is nearly full: about **1.5 GiB** free, and Lion shows its « Very Low Disk » warning.

### Why it was not a graphics problem

The same 10.7.5 build draws the installer GUI in `-vga std` (2026-11-04, mean luminance 144.81/255),
so the framebuffer and the console GOP path already worked. A white screen with a live framebuffer
and no daemons is a userspace bootstrap failure, which is what the `launchctl`/`rc.cdrom` chain
above describes. No Apple framebuffer driver, QE/CI or acceleration is involved or claimed.

### What is still impossible today

- The **ESD media was lost** (a cleanup of `%TEMP%`), so no clean `rc.install` reinstallation can be
  attempted: there is no installer copy left on that machine to run it from.
- The installed state is a **hybrid** produced by a **manual copy** (`cp -Rnp *`), not by
  `OSInstall`: package receipts, the BOM set and the boot layout are therefore not what a real
  installation produces.
- Everything in this section is **bare QEMU, outside the platform**. The later measurements are
  recorded further down: the v64 engine paints the login window (2026-11-10) and, on 2026-11-11,
  logs in and paints the Finder desktop with a USB keyboard and tablet, and since the same day the
  **product itself** boots it to the desktop
  ([Booted inside LumiBoot](#booted-inside-lumiboot-measured-on-2026-11-11)).
- `boot.efi` still has to be copied back from the ESD before the volume is bootable, and the volume
  remains too small to carry much more than Lion itself.

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
disk — the shape an ESP + installer pair needs — therefore requires a type-level change in this
repository, not a new device. The 2026-11-09 harness drove the engine directly, outside the
repository, and attached `hdb` without that change; `runtime.ts` still does not expose it. Separately,
the OVMF shipped with v64 is **byte-identical** to QEMU's: `ovmf-code.fd` sha256
`33090cc0…`, vars `5d2ac383…`. `AllowRelocationBlock` is an OpenCore setting, so blocker 1 needs **no
engine modification** at all.

None of this alone made macOS bootable in LumiBoot. What it did not test — the Mach-O `boot.efi`
container and the HFS+ handover **inside the v64 engine** — is measured separately below: as of
2026-11-09 both work there, and the stopping point has since moved past the kernel, past the login
window, to a **painted desktop with working input** (2026-11-11). On the same day the product
integration followed: the catalogue profile, the two-media manifest and a **245.0 s boot inside
LumiBoot** ([Booted inside LumiBoot](#booted-inside-lumiboot-measured-on-2026-11-11)).

## Inside v64, measured on 2026-11-09

The v64 engine was exercised directly, **outside this repository**, by an ad-hoc Playwright harness
on port 5200 driving the engine's own page. At that date none of it was a LumiBoot feature: there was
no profile, no image and no manifest, and the catalogue was untouched. The integration landed on
2026-11-11 ([Booted inside LumiBoot](#booted-inside-lumiboot-measured-on-2026-11-11)); this section
records the engine measurement itself. What changed is the **measured stopping point** — macOS no
longer stops before the engine; it starts inside
it, loads injected kexts, passes `Waiting for DSMOS...`, starts `WindowServer` and `loginwindow`,
on a decontaminated volume (2026-11-10) **paints the Lion login window**, and on 2026-11-11, with the
engine's new USB keyboard, **logs in and paints the Finder desktop**. The publication question is now
the Apple volume and the licence, not the engine:
[What cannot be published](#what-cannot-be-published).

### Stage by stage

| Stage | Measured result |
|---|---|
| OVMF x64 firmware | starts |
| OpenCore picker | `OpenCore Boot Menu REL-108-2026-09-27` displayed in **9 s**, entries `ESPOC`, **`Lion`**, `Recovery 10.7.5` |
| Apple `boot.efi` | loaded: `efiboot loaded from device … HD(Part2,SigDD5D010C-…)`, `boot file path: \System\Library\CoreServices\boot.efi` |
| kernelcache | read in full from `hdb` |
| kernel entry | prints `root device uuid is '2AD23999-7842-3144-9F30-1BD32FC403AD'` |
| 64-bit long mode | yes: `cs=0x08`, `csLong=1`, `efer=0xd00`, `cr0=0x80010033`, `cr4=0x20` |
| kernel startup | stopped on `panic("Unsupported CPU")`, `cpuid.c:819` — fixed by `Cpuid1Data` |
| preemption fault | stopped on a triple fault at `_idt64_preempt+0x20f`, `cr2=0x2f8` — **not reproduced** in the `esp-fsmc9.img` run, which carries the two `_tsc_init` patches |
| **DSMOS** | ✅ **passed** — `DSMOS has arrived` at t ≈ **213 s** (run A) and **228 s** (run B), with three kexts injected from the ESP |
| **`WindowServer` / `loginwindow`** | ✅ **both start** on the **decontaminated** volume; on the **contaminated** one neither appeared in 1800 s, see [the decontamination fix](#login-window-reached--the-decontamination-fix) |
| **Login window** | ✅ **reached in 249 s** — **201 s** on the second boot, **no reset**, `system.log` **62 170 bytes** |
| **Desktop** | ✅ **reached in the engine on 2026-11-11** — auto-login opens the session and the Finder desktop is painted (menu bar, Dock, Terminal) — see [Desktop, keyboard and mouse in v64](#desktop-keyboard-and-mouse-in-v64) |
| **Keyboard / mouse** | ✅ **both work** — USB HID boot keyboard (`Cmd+Espace` → Spotlight, `ls /`, `date`) and USB tablet pointer (Dock → Terminal); `usb-keyboard-active` true at 67.5 s |
| **LumiBoot** | ✅ **in the product since 2026-11-11** — the `macos-lion-x64` profile boots the two local media to a painted, stable Lion desktop in **245.0 s** ([Booted inside LumiBoot](#booted-inside-lumiboot-measured-on-2026-11-11)) |

### Blocker 1 — CPUID family/model, proven

v64 announces `CPUID.1:EAX = 0x00000673` (family 6, **model 7**). Lion's `cpuid.c` accepts only
`0x0f`, `0x17..0x2f` and `0x3a`, so it calls `panic("Unsupported CPU")` at **`cpuid.c:819`**; QEMU
`-cpu Penryn` announces `0x00010673` (model 23) and passes. The panic string was read in guest
memory at `0x8b0c80`, and the following `hlt` sits in `_Debugger+0x38`: with
`panic_is_inited == 0` the debugger never initialises, which is why the stop is completely silent —
no serial line, no screen output. The reported RIP `0xffffff80002c7ef9` is `_Debugger+0x39`, one
byte past the `hlt`, because v64 advances the EIP after that instruction.

### Workaround — force a Penryn CPUID leaf

This is reproducible without modifying this repository. In the loader's `config.plist` (OpenCore):

| Key | Value |
|---|---|
| `Kernel > Emulate > Cpuid1Data` | `7D 06 01 00 / 00 08 00 00 / 01 22 08 00 / FD FB 8B 07` |
| `Kernel > Emulate > Cpuid1Mask` | `ff` × 16 |

The panic disappears and the kernel continues, which proves the CPUID model is the blocker rather
than a symptom. It does not make the boot complete.

### Blocker 2 — triple fault when the kernel takes a preemption interrupt

With the workaround applied, the guest triple-faults at `rip = 0xffffff80002d9d3f`
(`_idt64_preempt + 0x20f`) with `cr2 = 0x2f8`. The instruction is `mov rcx, gs:[8]`
(`CPU_ACTIVE_THREAD`); `rcx` reads as `0`, so the next `cmp qword [rcx+0x2f8], 0` faults on
`0x2f8`, escalates `#PF` → double fault → triple fault → reset. The likely reading is a
**preemption timer interrupt delivered before `GS_BASE` is installed**, or a `swapgs`/MSR
`0xC0000101` emulation defect. **This is not settled**: both explanations fit the fault and
neither has been isolated. It is also **not reproduced** in the configuration that reaches DSMOS: the
ESP used there (`esp-fsmc9.img`) carries the **two `_tsc_init` patches**, and that run goes past the
point instead of resetting. Which difference of that configuration removes the fault is **not
isolated**.

### DSMOS passed — the three-kext injection

`Waiting for DSMOS...` is **crossed in v64** as of 2026-11-09: two independent runs print
`DSMOS has arrived` at **t ≈ 213 s** and **t ≈ 228 s**. The same screen also carries

```text
SMC::SmcInitHelper ERROR: MMIO regMap == NULL - fall back to old SMC mode
```

and the boot continues past it: that line reports the SMC firmware path falling back, it is not a
second stop.

| Measurement | Value |
|---|---|
| `DSMOS has arrived` | t ≈ **213 s** (run A), t ≈ **228 s** (run B) — same ESP, independent runs |
| `SMC::smcInitHelper` | **10 148 µs** to collect **16/16 keys** |
| key hash | `collision=6 maxCollision=2 maxCollisionHash=13` |
| SMC warning | `MMIO regMap == NULL - fall back to old SMC mode`, then `DSMOS has arrived` |
| `haltCount` after DSMOS | `0` — the engine keeps executing |

The configuration that works is the ESP **`esp-fsmc9.img`**:

| Item | Value |
|---|---|
| `Misc > Security > ScanPolicy` | **`0x10303`** |
| `Kernel > Emulate > Cpuid1Data` | Penryn leaf `7D 06 01 00 / 00 08 00 00 / 01 22 08 00 / FD FB 8B 07`, `Cpuid1Mask` `ff` × 16 |
| `Kernel > Patch` | the **two** `_tsc_init` patches |
| `boot-args` | `debug=0x8` |
| OpenCore | **1.0.8 DEBUG**; `ocvalidate` reports no error |
| `Kernel > Add` | **three** kexts, in this order |

| # | Kext | Version | Arch | Role |
|---|---|---|---|---|
| 1 | `AppleSMC.kext` | 3.1.3d10 | x86_64 | supplies `com.apple.driver.AppleSMC` and a non-zero `AppleSMCFamily` symbol to OpenCore's prelinked injection |
| 2 | `FakeSMC.kext` | 5.3.901 | `Any` | answers the SMC keys; logs `SMC: successfully initialized` |
| 3 | `DontSteal.kext` | Dont Steal Mac OS X 7.0.0 | x86_64 | the Lion-era DSMOS counterpart, injected with the other two |

Why three, measured:

- **FakeSMC alone** injects (`SMC: successfully initialized`) but `DSMOS` stays blocked: the key
  service answers while the platform handshake never completes;
- **without `AppleSMC`**, OpenCore refuses the injection and logs:

  ```text
  OCAK: Dependency com.apple.driver.AppleSMC was not found
  OCAK: Symbol __ZN14AppleSMCFamily9metaClassE has 0-value
  ```

  The installed kernelcache exports `AppleSMCFamily` at **0**, so the symbol cannot be resolved from
  the cache and has to come from an injected kext;
- **with `AppleSMC` injected**, both `OCAK` lines disappear and the boot reaches
  `DSMOS has arrived`.

`FakeSMC.kext` is **5.3.901** here and it does inject, unlike 3.5.6: its binary carries **no**
`configureReport`/`IOReport` vtable reference and **no** `LC_SOURCE_VERSION`, which is exactly what
made 3.5.6 unloadable on 10.7. The 5.3.901 archive used is **byte-identical** to the GitHub archive
`Cozmonat/HWSensors` 5.3.901 (zip SHA-256 `497A9FEC…AE19`), so the local copy is not a modified build.

### Login window reached — the decontamination fix

Measured on **2026-11-10**, in the same outside-the-repository harness: with the installed volume
**decontaminated**, the v64 engine paints the **Lion login window**. It is the **same correction that
was applied under QEMU on 2026-11-08** ([Why it was white before](#why-it-was-white-before)) — a
reversible rename to `.disabled`, nothing else changes in the volume:

| Renamed to `.disabled` | Note |
|---|---|
| `/etc/rc.cdrom` | the trigger; `launchd` runs it whenever it is present, whatever the plist says |
| `/etc/rc.cdrom.orig2` | same script, second copy |
| `/etc/rc.install.orig` | installation path |
| `/etc/rc.imaging` | imaging path |
| `/System/Installation` | the installation payload directory |

| Measurement | Value |
|---|---|
| Login window | ✅ **reached in 249 s** (first boot) — **201 s** on the second boot |
| Reset or reboot during the boot | **none** |
| `system.log` | **62 170 bytes** |
| Input | **not received on that date** — the engine had no usable USB HID yet; keyboard and pointer work since 2026-11-11, see [Desktop, keyboard and mouse in v64](#desktop-keyboard-and-mouse-in-v64) |
| Capture | `clean-v64/ecran-connexion-v64.png`, taken outside this repository (not versioned) |

**The LFB is not implicated.** The clean boot paints that login window with the **same** linear
framebuffer at `0x80000000` as the contaminated boot, and `vga_mem_size` set to 8, 16 or 32 MiB
changes nothing. Framebuffer, console-GOP handover and the Bochs VGA adapter all work; what failed
before was userspace, not graphics.

**Input did not work at that point.** macOS carries **no PS/2 keyboard/mouse kext** in this volume,
and the engine of 2026-11-10 exposed **no usable USB HID**, so no keystroke and no pointer event
reached the guest: the login window was displayed and the session was not. That wall was crossed on
2026-11-11 with the engine's USB keyboard and tablet — see
[Desktop, keyboard and mouse in v64](#desktop-keyboard-and-mouse-in-v64) — and the product followed
the same day: the desktop is reached **inside LumiBoot**
([Booted inside LumiBoot](#booted-inside-lumiboot-measured-on-2026-11-11)), with the measured limits
listed there and no Apple-hardware compatibility claim.

### Desktop, keyboard and mouse in v64

Measured on **2026-11-11**, in the same harness outside this repository (v64 engine, Playwright on
port 5200, the installed and decontaminated Lion 10.7.5 volume). The engine now reaches the **Finder
desktop** and **accepts input** — keyboard and pointer — which was the last stop recorded above.

| Measurement | Value |
|---|---|
| Desktop | ✅ **painted** — menu bar, Dock, a Terminal window; capture `autologin-v64/v64-01-bureau-300s.png` |
| Auto-login | configured on a **copy of the image**: `/Library/Preferences/com.apple.loginwindow` → `autoLoginUser=lumi`, plus `/etc/kcpassword` (12 bytes) |
| Keyboard | ✅ **works** — `Cmd+Espace` opens Spotlight (`autologin-v64/v64-11-clavier-spotlight-cmd-espace.png`); `ls /` typed and executed (`v64-13`, `v64-14`); `date` (`v64-15`) |
| Keyboard evidence in the engine | `usb-keyboard-active` **true at 67.5 s** — the HID driver is bound by macOS, not merely present |
| Mouse | ✅ **works** — USB **tablet**, `usb-tablet-active`: the cursor moves and a Dock click opens Terminal |
| PS/2 | ❌ **definitively ruled out** — Lion 10.7.5 ships **no PS/2 kext at all**: 0 of the **233** kexts in `/S/L/E`, 0 in the BaseSystem, and the engine's `mouse-enable` event is **never** emitted |

Both USB devices are real engine work, not operator tricks: the keyboard lives in the engine, in the
**third** patch of the locked chain.

| Patch | Scope |
|---|---|
| `scripts/patches/v64-usb-keyboard.patch` | **8 files**, incl. the new `src/usb/hid_keyboard.js`: a USB HID **boot keyboard**, 8-byte reports, **one transition per keystroke**, opt-in `usb.keyboard`, driven by the bus's `keyboard-usage` and announcing `usb-keyboard-active` |
| `scripts/patches/v64-ata-power-management.patch` | ATA STANDBY `0xE2`, IDLE `0xE3`, SLEEP `0xE6` now complete with **DRDY + IRQ**: removes the AHCI livelock (`0xE6` used to leave `tfd=0x50`, one port `halted`); reads over HTTP keep flowing |

Consequences recorded with the patches: the chain is now three patches,
`scripts/build-v64-assets.sh` builds **seven** targets, `v86-usb.js` is **now pinned** in
`scripts/v64-assets.lock.json` (it was not, which is how an unverified USB plugin could be shipped),
and `node scripts/prepare-v64-assets.mjs --check` passes **19/19**. All of it is now used by the
`macos-lion-x64` profile: the patches are engine material, applied by the build script, and the
profile declares `v64Smc`, `v64UsbKeyboard` and `v64UsbTablet`.

Measured limits, to be read as such:

- **US key mapping only** — no AZERTY: the boot keyboard reports US scancode transitions, so a
  French layout is typed as its QWERTY positions;
- **the menu bar is painted late** — between **300 s and 460 s** after the start, well after the
  session opens; a screenshot taken too early shows a desktop without it;
- **2 starts out of 5 froze on a grey screen** — the instruction counter stalls at ≈ **275 s**,
  after an abrupt stop of the engine. The freeze is **not** linked to USB: the proof was redone on a
  **fresh copy** of the image and did not reproduce;
- **the LumiBoot figures are newer than these** — everything in this harness section comes from the
  harness page on port 5200; the product boot has its own measurements, recorded in
  [Booted inside LumiBoot](#booted-inside-lumiboot-measured-on-2026-11-11).

### The contaminated image — the 2026-11-09 stop, and the "crash" that was a reboot

Past `DSMOS has arrived` the **2026-11-09** runs did not reach a session: in a **1800 s** observation
neither `WindowServer` nor `loginwindow` appeared, and the screen stayed frozen on the verbose
console. Those runs used the **contaminated** volume, the one still carrying `rc.cdrom`/`rc.install`;
the decontaminated boot reaches the login window instead
([above](#login-window-reached--the-decontamination-fix)).

Reading that failure as a graphics crash was wrong. The post-mortem names the real sequence:

| Apparent "crash" | What it actually was |
|---|---|
| RIP `0xffffff7f8198897d`, `AppleACPIPlatform::_AcpiOsWritePort+0x19` | the `out 0xCF9` write of an **ordered `reboot(2)`**, not a fault |
| the white screen | the Installer's **empty window** in front of `loginwindow` — both alive, nothing drawn |
| `CR2` | a **userland `#PF`**, captured truncated — not a kernel fault in the graphics path |
| sequence | `rc.cdrom` → `rc.install` → `WindowServer` killed (`Terminated: 15`) → « The Installer has quit due to an unexpected error » → `/sbin/reboot` → `out 0xCF9` |

So the stop was an **ordered reboot initiated by `rc.install`**, which had killed the window server
first: one launchd chain, not a rendering fault. That also rules the framebuffer out, as the
decontaminated boot proves by painting with the **same** LFB at `0x80000000`; `vga_mem_size` 8/16/32
MiB is a non-factor.

The log was readable because it was read **in the guest RAM** at reset: `system.log` was still there
(**442 occurrences**) even though `/var/log` sat on a **RAM disk** the reset destroyed — which is
what made it possible to name the initiator.

Recorded on that 2026-11-09 contaminated image:

| Observation | Measured value |
|---|---|
| `WindowServer` | **absent** after 1800 s |
| `loginwindow` | **absent** after 1800 s |
| `AppleAHCIDiskQueueManager` | **two timeouts** printed on the console |
| `haltCount` | `0` — the engine is still executing: a stop, not a hang |
| Screen | frozen on the verbose console |
| QEMU control | the **same disk** starts `WindowServer` about **400 s** after the boot |

The two `AppleAHCIDiskQueueManager` timeouts were recorded while userspace was still coming up; they
are a **symptom candidate, not a proven cause**. The **cacheless** hypothesis (`KernelCache=None`, the
kernel resolving kexts from `/System/Library/Extensions` instead of the prelinked cache) is now
**moot**: the same volume starts `WindowServer` and paints the login window once `rc.install` and
friends are renamed out, so that stop was the CD/installation chain, not the cache.

**That stop was the CD/installation chain, not a desktop limit**: with the volume decontaminated the
login window is painted, and since 2026-11-11 the session opens and the Finder desktop is drawn —
see [Desktop, keyboard and mouse in v64](#desktop-keyboard-and-mouse-in-v64).

### What was ruled out, measured

| Suspect | Measurement |
|---|---|
| disk transport | 1 042 Range requests, 44.9 MiB, all `206` |
| throughput | 47.5 MiB/s, 211 MIPS |
| HPET | QEMU with `hpet=off` starts in 0.146 s and hits the same stop |
| chipset | `q35` and `i440fx` behave identically |
| CPU worker | `worker=0` gives the same stop |
| `EnableWriteUnprotector`, `ProvideCustomSlide` | no effect |
| Clover as the loader | never reaches its menu: busy-waits on a scan flag v64 never signals — a second, distinct v64 bug |

### What is still wrong in v64 (CPUID fidelity, secondary)

Even with the workaround, v64's CPUID surface is not a Penryn: `0x80000000.EBX/ECX/EDX` and
`0x80000001.EAX` read `0`, an invariant TSC is advertised, and `RDTSCP`, `AVX`, `XSAVE` and
`RDRAND` are announced although Penryn has none of them. None of this causes the current stops
(start stability, menu-bar latency), but a kernel that trusts those leaves would misbehave later.

### What is still missing

- **LumiBoot integration** — done on 2026-11-11: the `macos-lion-x64` profile, its two-media
  `manifest.json` and the catalogue entry exist, `runtime.ts` exposes `hdb`, and the product boots to
  the desktop in 245.0 s
  ([Booted inside LumiBoot](#booted-inside-lumiboot-measured-on-2026-11-11)). The remaining product
  work is stability, not integration;
- **distribution of the ESP** — the working boot ESP is now kext-free and rebuildable from OpenCore
  files (no Apple binary), see [What cannot be published](#what-cannot-be-published): what still
  cannot ship is the installed Apple volume itself;
- **stability** — 2 starts out of 5 froze on a grey screen (instruction counter stalled at ≈ 275 s)
  after an abrupt engine stop. Not USB-related — the proof was redone on a fresh copy of the image —
  but a start that fails two times in five is not a product, and the cause is not isolated;
- **CPUID family/model fidelity** — the engine still announces family 6 **model 7**, so the loader
  must keep overriding it with `Cpuid1Data`, which requires operator configuration, and the wider
  leaves listed above stay wrong;
- **timer / `GS_BASE` at kernel start** — the `_idt64_preempt` fault is not reproduced in the
  `esp-fsmc9.img` configuration (which carries the two `_tsc_init` patches), but the underlying
  question (`swapgs` / `IA32_GS_BASE` emulation) is not answered.

**A desktop has been reached in the v64 engine** (2026-11-11, keyboard and mouse included) **and, since
the same day, inside LumiBoot** — 245.0 s to a painted and stable Lion desktop with the catalogue
profile, no injected kext and no Apple binary in the ESP
([Booted inside LumiBoot](#booted-inside-lumiboot-measured-on-2026-11-11)). What remains is stability,
the Apple media distribution question and the licencing limit, not a compatibility claim on Apple
hardware.

## What is missing on the v64 side

The v64 engine boots Linux, Windows 11 and — since 2026-11-11, inside the product — macOS Lion
([`docs/v64.md`](../../docs/v64.md)). For macOS, the
list below is ordered by what the engine was actually measured doing on 2026-11-09, 2026-11-10 and
2026-11-11: the first two lines are **bypassed by operator configuration, not fixed in the engine**,
lines 3, 4, 7 and 10 are answered, and the rest are hypotheses the guest has not reached. The
bare-QEMU installation above did
exercise a QEMU SMC device, an SMBIOS model and ICH9 AHCI — but in QEMU, not in v64, so none of those
lines changes status here. The 2026-11-08 desktop boot does not change that either: it ran on QEMU
with FakeSMC instead of the QEMU SMC device, and no part of it touched the browser engine.

| # | Missing piece | Why it blocks a macOS guest | Evidence |
|---|---|---|---|
| **1** | **CPUID family/model fidelity** | v64 reports `CPUID.1:EAX = 0x00000673` (family 6, model 7); Lion accepts only `0x0f`, `0x17..0x2f`, `0x3a` and calls `panic("Unsupported CPU")` at `cpuid.c:819`. Forcing a Penryn `Cpuid1Data` removes the panic. The wider surface is also wrong: `0x80000000.EBX/ECX/EDX` and `0x80000001.EAX` read `0`, invariant TSC is advertised, and `RDTSCP`/`AVX`/`XSAVE`/`RDRAND` are announced although Penryn lacks them | measured, bypassed by `Cpuid1Data` |
| **2** | **Preemption timer / `GS_BASE` at kernel start** | After the CPUID workaround the kernel triple-faults at `_idt64_preempt+0x20f` (`cr2 = 0x2f8`): `mov rcx, gs:[8]` yields `rcx = 0`, then `cmp qword [rcx+0x2f8], 0` faults. Either a timer preemption runs before `GS_BASE` is installed, or `swapgs`/MSR `0xC0000101` is mis-emulated — **not settled**. The stop is **not reproduced** in the `esp-fsmc9.img` configuration (two `_tsc_init` patches); which difference removes it is not isolated | bypassed in practice; root cause open |
| 3 | HFS+ reader and Apple `boot.efi` handover | **No longer a blocker inside v64**: the OpenCore picker appears in 9 s, `boot.efi` loads, the whole kernelcache is read from `hdb` and the kernel enters long mode — see [Inside v64](#inside-v64-measured-on-2026-11-09) | measured, answered |
| 4 | SMC / DSMOS | **Answered**: `AppleSMC` 3.1.3d10 + `FakeSMC` 5.3.901 + `DontSteal` 7.0.0 injected from `esp-fsmc9.img` reach `DSMOS has arrived` at t ≈ 213 s and 228 s — see [DSMOS passed](#dsmos-passed--the-three-kext-injection) | measured, answered |
| 5 | Apple SMBIOS/DMI model | No model injection: the kernel would see a generic PC, not a Mac | not reached |
| 6 | AHCI/ICH9 for macOS | The controller still boots Windows 11 (`storahci`), but it has never carried an Apple kext | not reached |
| 7 | Rendering / framebuffer | **Answered for the login window and the desktop**: Bochs VGA paints both with the LFB at `0x80000000`, and `vga_mem_size` 8/16/32 MiB changes nothing — see [Login window reached](#login-window-reached--the-decontamination-fix) and [Desktop, keyboard and mouse in v64](#desktop-keyboard-and-mouse-in-v64). Still no QE/CI and no acceleration; the menu bar is painted late (300–460 s) | measured, answered |
| 8 | Throughput on an 8 GiB disk | **Answered in effect**: the 8 GiB installed volume itself boots to the login window in 249 s (201 s on reboot); no separate MiB/s figure was re-measured | measured |
| 9 | TPM 2.0 / Secure Boot | Out of scope: Lion needs neither, and v64 exposes neither | out of scope |
| 10 | Guest input (keyboard/mouse) | **Answered**: PS/2 is definitively out (Lion 10.7.5 ships **no** PS/2 kext — 0 of 233 in `/S/L/E`, 0 in the BaseSystem; the engine's `mouse-enable` never fires), and the engine now carries a USB HID boot keyboard and a USB tablet: `Cmd+Espace` opens Spotlight, `ls /` and `date` run, the pointer moves and a Dock click opens Terminal — see [Desktop, keyboard and mouse in v64](#desktop-keyboard-and-mouse-in-v64) | measured, answered |

SMC is no longer the wall: the three-kext ESP passes `DSMOS has arrived`, so the earlier
`Waiting for DSMOS...` stop was an SMC/injection problem and **not** a kextcache problem — the
working recipe changes the **injected set**, not the cache (see
[DSMOS passed](#dsmos-passed--the-three-kext-injection),
[FakeSMC: installed vs injected](#fakesmc-installed-vs-injected)).

Input is no longer the wall either: keyboard and pointer reach the guest and the Finder desktop is
painted (lines 7 and 10 answered). The 2026-11-09 stop — no `WindowServer` in 1800 s — was the
contaminated `rc.install` image, not the framebuffer. With the engine's SMC the kext-free ESP boots the
same desktop **inside LumiBoot** (245.0 s,
[Booted inside LumiBoot](#booted-inside-lumiboot-measured-on-2026-11-11)), so the remaining gaps are
**stability** (2 starts in 5 frozen on a grey screen, not USB-related, on a fresh copy), the **Apple
volume** itself (never distributed) and the licence. The lines above cannot be evaluated out of order.

### What cannot be published

The boot ESP that made the **2026-11-09** runs work carried three injected kexts, and two of them are
Apple binaries or Apple-derived:

| Member of the old working ESP | Why it cannot ship |
|---|---|
| `AppleSMC.kext` 3.1.3d10 | **Apple's own kext**, taken from the operator's Lion install. Redistributing it is redistribution of Apple code |
| `DontSteal.kext` 7.0.0 | the Lion-era DSMOS counterpart, **Apple binary** as well |
| `FakeSMC.kext` 5.3.901 | free software, but useless alone: the injection fails without `AppleSMC` (`OCAK: Dependency com.apple.driver.AppleSMC was not found`) |

**That constraint is now gone for the ESP.** The **engine** emulates the Apple SMC (`v64Smc`, Device
`APP0001`), so `Kernel > Add` is empty and the published `esp.img` holds only OpenCore 1.0.8 files:
`BOOTx64.efi`, `OpenCore.efi`, `config.plist`, `HfsPlus.efi`, `HfsPlusLegacy.efi`,
`OpenRuntime.efi` — **no Apple kext**, verified by a byte scan (`com.apple.driver.AppleSMC`,
`FakeSMC`, `DontSteal`: 0 occurrence). What still cannot be distributed is the **installed Lion
volume** (`disk.img`), which is Apple's operating system and stays a Git-ignored local file; the
licence question is independent of both.

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
- [x] **Desktop** — done on 2026-11-08, **outside LumiBoot**. The installed 10.7.5 volume boots
      under QEMU 9.2/TCG + OVMF x64 + OpenCore 1.0.8 to the login window, then the full Lion desktop,
      with FakeSMC 5.3.901 and the QEMU SMC device removed. 225 `launchd` jobs, `WindowServer` PID 82,
      `loginwindow` PID 41; captures `out/T05_boot/ui_desktop3.png` and
      `out/T06_boot/ui_login.png` — [Desktop reached](#desktop-reached-measured-on-2026-11-08).
      Reserve: the installed state is a **hybrid produced by manual copy, not by `OSInstall`**, and
      the ESD media was lost, so it cannot be reproduced from this machine.
- [x] **v64 gap analysis — desktop reached in the engine, then in the product** — on 2026-11-09, outside
      this repository, the v64 engine (driven by a Playwright harness on port 5200) displayed the
      OpenCore picker in 9 s, loaded Apple's `boot.efi`, read the whole kernelcache from `hdb`,
      entered 64-bit long mode and reached the Lion kernel. It first stopped on
      `panic("Unsupported CPU")` (`cpuid.c:819`, CPUID model 7) and, with `Cpuid1Data` forced to
      Penryn alone, on a triple fault at `_idt64_preempt+0x20f` (`cr2 = 0x2f8`). With the two
      `_tsc_init` patches and a **three-kext** injection (`AppleSMC` 3.1.3d10, `FakeSMC` 5.3.901,
      `DontSteal` 7.0.0 in that order), `Waiting for DSMOS...` is **crossed**: `DSMOS has arrived` at
      t ≈ 213 s and 228 s. On 2026-11-10 the **decontaminated** volume — the same `.disabled` renames
      as under QEMU (`rc.cdrom`, `rc.cdrom.orig2`, `rc.install.orig`, `rc.imaging`,
      `/System/Installation`) — paints the **Lion login window in 249 s** (201 s on the second boot),
      with no reset and a 62 170-byte `system.log`. The earlier "no `WindowServer` in 1800 s" stop was
      that image's `rc.install` chain killing the window server and ordering a `reboot(2)`
      (`out 0xCF9`), not a graphics fault; the same LFB `0x80000000` paints the clean boot, and
      `vga_mem_size` 8/16/32 MiB changes nothing. On **2026-11-11** the same harness reaches the
      **Finder desktop**: auto-login (`autoLoginUser=lumi` + `/etc/kcpassword` on a copy of the
      image), a **USB HID boot keyboard** (`Cmd+Espace` → Spotlight, `ls /`, `date`,
      `usb-keyboard-active` at 67.5 s) and a **USB tablet** (cursor, Dock click → Terminal), with
      the engine patches `v64-usb-keyboard.patch` and `v64-ata-power-management.patch` — see
      [Desktop, keyboard and mouse in v64](#desktop-keyboard-and-mouse-in-v64). Limits: **US keys
      only**, menu bar painted late (300–460 s), **2 starts in 5 frozen on a grey screen** (≈ 275 s,
      not USB-related). `runtime.ts` now exposes `hdb`, the kext-free ESP is publishable
      ([What cannot be published](#what-cannot-be-published)) and the product boot is recorded below:
      see [Booted inside LumiBoot](#booted-inside-lumiboot-measured-on-2026-11-11).
- [x] **Catalogue profile** — done on 2026-11-11: `images.ts` (`macos-lion-x64-image`), `profiles.ts`
      (`macos-lion-x64`, v64 + OVMF + q35 + `v64Smc` + USB HID, `diskBootReadiness`) and the docs.
      `validated: true` is set **after** the real boot inside LumiBoot recorded below, and is reverted
      as soon as a rebuild stops matching.

## Booted inside LumiBoot, measured on 2026-11-11

The **product** now boots this pair. `tests/e2e/macos-lion-desktop.spec.ts` (port 5200, Chromium,
`VM_E2E_ASSETS=1`) opens `/systems/macos-lion-x64`, clicks **Start session**, and waits for the real
VGA canvas: mean luminance between 45 and 245/255, more than 50 % non-white pixels, more than 64
distinct colours, held over three consecutive measurements. It captures the screen in
`test-results/`.

| Measurement | Value |
|---|---|
| Profile | `macos-lion-x64` (`engineId: v64`, browser, 2048 MiB, 32 MiB VGA) |
| Boot | OVMF → OpenCore 1.0.8 on the 64 MiB ESP (`hda`) → `boot.efi` on the HFS+ Lion disk (`hdb`) |
| SMC | emulated by the engine (`v64Smc`, Device `APP0001`); **no kext injected** |
| Input | USB HID boot keyboard + USB tablet (UHCI), as the profile declares |
| **Desktop** | ✅ **245.0 s** after the Start click (click → first stable measurement) |
| Canvas | 1024x768, mean luminance **205.9/255**, **97.8 %** non-white, **215** colours, 3 stable polls |
| Disk read | **180.09 MiB** over **10 028** HTTP Range requests |
| ESP read | **1.68 MiB** over **40** HTTP Range requests |
| Guest RAM | 2048 MiB (manifest) |
| Capture | [`bureau-lumiboot-245s.png`](bureau-lumiboot-245s.png) — Andromeda wallpaper, Dock, System Preferences, session `lumi`; the 245 s proof frame is next to it as `bureau-lumiboot-245s-preuve.png` |

Read as measured, not as a product promise:

- **slow** — 245 s to the desktop on a fast host, under software emulation, with no graphics
  acceleration and **no QE/CI**;
- **US key mapping only** — the HID keyboard reports US positions, so an AZERTY layout is typed as
  QWERTY;
- **no network** — the profile declares `hardwareProfile.network: "none"`; the emulated SMC owns the
  I/O ports `0x300-0x31F` and a NE2000 cannot share them;
- **the menu bar paints late** — the proof frame at 245 s is the System Preferences window over the
  desktop; the Dock and the wallpaper are there, the menu bar follows within minutes;
- **stability** — the earlier harness measured 2 starts out of 5 frozen on a grey screen (≈ 275 s,
  not USB-related). This spec is the honest check: it fails instead of pretending, and the
  `validated` flag must be reverted as soon as a rebuild stops reaching it;
- **the disk is a hybrid** produced by a manual copy, not by `OSInstall` (see
  [What is still impossible today](#what-is-still-impossible-today)), and `/S/L/E` still carries the
  campaign's FakeSMC, which disables itself (`FakeSMC: [Fatal] SMC device detected, will not create
  another one`) because the engine's SMC is present.

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

## Publishing locally

The installed volume and its loader can be laid out as a **local, two-media asset** that the dev
middleware serves under `/images/macos-lion-x64/`. Nothing is published by it: no
`apps/web/public/images/` copy and no Apple media — the catalogue profile only references these two
Git-ignored local files, and the status above is a measured, operator-side result.

| File in `images/macos-lion-x64/` | Size (bytes) | SHA-256 |
|---|---:|---|
| `disk.img` | 8 589 934 592 | `7243420D9559727B4CA2DA7E314D00F626D7D20BBB0F1371D430EB6F9B4398E0` |
| `esp.img` | 67 108 864 | `BCD6E67ADDB3DE5649A658AA85C0175BF0B2F19EFBD146C00CB5B5785890FCE5` |

`disk.img` is the installed, decontaminated 10.7.5 volume with `autoLoginUser=lumi`; `esp.img` is the
OpenCore 1.0.8 **DEBUG** ESP (`BOOTx64.efi`, `OpenCore.efi`, `config.plist`, `HfsPlus.efi`,
`HfsPlusLegacy.efi`, `OpenRuntime.efi`), with `Cpuid1Data` forced to Penryn, the two `_tsc_init`
patches and `Kernel > Add` empty. It has **no `Kexts` directory**, so it carries **no Apple kext**:
`com.apple.driver.AppleSMC`, `DontSteal` and `FakeSMC` occur **0 times** in the image. The three-kext
injection that crossed `Waiting for DSMOS...` lives in the operator's other ESP (`esp-fsmc9.img`) and
is not part of this asset — see [What cannot be published](#what-cannot-be-published). The kext-free
ESP passes `Waiting for DSMOS...` **without** it, because the SMC is now emulated by the engine
(`v64Smc`, Device `APP0001`, ports `0x300`/`0x304`, IRQ 6): the boot reaches the Finder desktop
([Booted inside LumiBoot](#booted-inside-lumiboot-measured-on-2026-11-11)).

Two loader details matter for an unattended boot:

- **`Misc > Boot > ShowPicker = true` with `HideAuxiliary = true`**: the text menu then lists
  `Lion` **alone** (`OCB: BlessedFileHEX … com.apple.recovery.boot\boot.efi`,
  `OCB: Discarding recovery entry due to auxiliary`) and boots it on its own timeout. With
  `ShowPicker = false` OpenCore boots the **blessed** file instead, which is the Recovery volume —
  measured: the « Mac OS X Utilities » GUI, not the desktop;
- **no input is available at that menu in LumiBoot**: OpenCore logs
  `OCII: AmiEfiKeycodeProtocol is unavailable on gST->ConsoleHandle - Unsupported`, so the boot must
  never depend on a keystroke. The earlier harness runs drove the picked entry through
  `keyboard_send_scancodes` (PS/2), which only the harness page exposes.

Both `.img` files are Git-ignored (`*.img`); `manifest.json` and the generated `provenance.txt` follow
the same convention as the other local disks ([`docs/v64.md`](../../docs/v64.md)).

```bash
# 1. Manifest of the two-media layout: ESP on hda (SATA port 0), system disk on hdb.
pnpm assets:macoslion:prepare -- --source images/macos-lion-x64/disk.img

# 2. Verify it without writing anything: size, mtime, SHA-256 of the disk, size and SHA-256 of the ESP.
pnpm assets:macoslion:check
```

The disk image is **supplied by the operator** — the already installed Lion volume, restored from the
Apple installer — and `esp.img` is an **OpenCore image that carries no Apple binary**. The wrapper
`scripts/prepare-macos-lion-asset.mjs` supplies the macOS defaults (`ref: macos-lion-x64`, x86-64,
2048 MiB, 32 MiB VGA, `engine: v64`, `source: images/macos-lion-x64/disk.img` or `MACOS_LION_IMG`,
`esp: images/macos-lion-x64/esp.img` or `MACOS_LION_ESP`, licence, provenance and notes) and forwards
the generator's options (`--esp`, `--force`, `--skip-hash`, `--resume`, `--json`, `--copy-to`).
`pnpm assets:macoslion:prepare` alone picks up the two files above, `-- --force` regenerates an
existing manifest, and `--check` needs neither `--source` nor `--esp`: it follows the recorded paths.

The manifest records `esp` (`fileName`/`url`/`size`), `disk`, `boot` (`mode: disk-boot`, same URL and
size as `disk`) and `engine: { "id": "v64" }`, and **no absolute path**: `source.path` is
`images/macos-lion-x64/disk.img`. `--check` re-hashes 8 GiB and prints `✓ Manifest matches` (exit 0).

Measured on a dev server bound to port 5310 (`vite --port 5310 --strictPort`, never the developer's
5173); the middleware logs `macos-lion-x64 8 GiB (+ ESP)` then
`ESP ready (HTTP Range): /images/macos-lion-x64/esp.img`:

| Request | Answer |
|---|---|
| `GET /images/macos-lion-x64/manifest.json` | **200**, `application/json; charset=utf-8`, 1 196 bytes; the served copy keeps `esp`, `engine.id = v64` and `boot.mode = disk-boot`, and drops `source`/`provenance` |
| `GET /images/macos-lion-x64/esp.img` with `Range: bytes=0-511` | **206**, `Content-Range: bytes 0-511/67108864`, 512 bytes |
| `GET /images/macos-lion-x64/disk.img` with `Range: bytes=0-1023` | **206**, `Content-Range: bytes 0-1023/8589934592`, 1 024 bytes |

The catalogue profile is now published (`packages/catalog/src/profiles.ts`, `validated: true`) and the
real boot inside LumiBoot is recorded above, with its capture. What is **not** a publishing problem
and still limits production: the stability figure (2 starts in 5 frozen on a grey screen), the fact
that the working ESP is still an operator-side artifact (the SMC is emulated by the engine, so no
Apple kext ships — but the installed volume is a manual hybrid), and the licensing question. Until
those settle, this asset is an operator-side artifact with a recorded, reproducible boot.
