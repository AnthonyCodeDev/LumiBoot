# Windows 7 under v86

Two validated variants, BIOS-booted from local RAW disks.

| Variant | Reference | Disk | RAM | Order |
|---|---|---:|---:|---:|
| Professional SP1 x86 | `windows-7-pro-sp1-x86` | 32 GiB | 1536 MiB | 1, default |
| Lite x86 | `windows-7-x86` | 16 GiB | 1024 MiB | 2, parent |

`images/<ref>/disk.img` and `provenance.txt` are ignored by Git; the versioned `manifest.json` contains no absolute machine path. No Windows image, ISO or key is distributed.

## Preparing a disk

```bash
node scripts/prepare-windows7-asset.mjs \
  --source images/windows-7-pro-sp1-x86/disk.img \
  --ref windows-7-pro-sp1-x86 \
  --display-name "Windows 7 Professionnel SP1 x86" \
  --architecture i386 --memory-mib 1536 --vga-mib 16 \
  --out images/windows-7-pro-sp1-x86
```

Source opened read-only, streaming SHA-256 (8 MiB blocks), writes limited to `manifest.json` and `provenance.txt`. Options: `--skip-hash` (no SHA-256, size and `mtime` recorded), `--resume` (existing SHA-256 reused when size and `mtime` match), `--force` (overwrites an existing manifest, mandatory otherwise), `--check` (verifies without writing; `--source` required for an external disk), `--copy-to` (verified copy, refused onto the source or into `public/`).

`pnpm assets:windows7:check` is equivalent to `--check`. A disk outside the repository records no path (`source.external`): `--source` becomes mandatory for any verification.

## Development

`pnpm dev` loads the `scripts/lib/disk-asset-dev.mjs` middleware (`apps/web/vite.config.ts`), which discovers every `images/<ref>/manifest.json` with `boot.mode === 'disk-boot'` and serves the disk in place on `/images/<ref>/disk.img` over HTTP Range `206`, plus the public form of the manifest (without `source` or `provenance`).

Attached as `hda.async`, never as a CD-ROM. v86 writes stay in memory and disappear on stop; the source file is not modified.

## Readiness

No guest marker: `disk-boot` switches to `running` on the first real IDE read of the disk (`ide-read-end`, channel 0, bytes > 0, `packages/provider-v86/src/v86-instance.ts:328-335`), 300 s timeout (`packages/catalog/src/profiles.ts:102-109`). That proof attests booting, not a working desktop; the E2E test then covers the VGA canvas.

```powershell
$env:VM_E2E_ASSETS='1'
pnpm exec playwright test tests/e2e/windows7-desktop.spec.ts
```

Playwright serves the app on port `5200`. Without `VM_E2E_ASSETS=1`, the real tests are skipped (16 and 32 GiB disks).

## Network (Internet inside the guest)

**NE2000 (`ne2k`)** adapter: profiles declare `hardwareProfile: { ...pcHardware('ne2k'), acpi: true }` (`packages/catalog/src/profiles.ts:274,313`), translated into `net_device.type = 'ne2k'` by `toV86NetworkDeviceType` (`packages/provider-v86/src/network/V86NetworkAdapter.ts`). Windows 7 ships no inbox driver for this card: without an installed NE2000/RTL8029 driver, the guest reports "No connections are available", whatever the network mode (see v86, [§5.3 Enabling networking](https://github.com/copy/v86/blob/master/docs/windows-nt.md)).

The driver must be present **inside `disk.img`**: the disk is served read-only, so the installation happens offline in QEMU, before preparing or regenerating the manifest. Windows 10 x86 uses `virtio-net` (see [`windows-10.md`](windows-10.md)).

### Installing the driver offline (QEMU)

```bash
qemu-system-i386 \
  -drive file=images/windows-7-pro-sp1-x86/disk.img,format=raw,if=ide \
  -m 1536 \
  -nic user,model=ne2k_pci \
  -cdrom drivers-ne2000.iso
```

1. mount the NE2000/RTL8029 ISO (or its extracted folder);
2. select the unknown "Ethernet Controller" in Device Manager;
3. **Update driver** → "Browse my computer" → point to the folder or the CD;
4. accept the unsigned driver if Windows asks, reboot, verify with `ipconfig /all`.

Then regenerate the manifest:

```bash
pnpm assets:windows7:prepare --force \
  --source images/windows-7-pro-sp1-x86/disk.img \
  --ref windows-7-pro-sp1-x86 \
  --display-name "Windows 7 Professionnel SP1 x86" \
  --architecture i386 --memory-mib 1536 --vga-mib 16 \
  --out images/windows-7-pro-sp1-x86

pnpm assets:windows7:check
```

### LumiBoot side

The `net_device` combines the profile adapter (`ne2k`) and the mode transport; absent only in `offline` (`packages/provider-v86/src/V86Provider.ts:219-223,291`).

| Effective mode | Guest network |
|---|---|
| `offline` | no NIC |
| `browser-fetch` | ne2k + fetch backend: HTTP 80 only, CORS |
| `local-proxy` | ne2k + WISP to the paired proxy, outbound TCP |
| `user-relay` | ne2k + WISP to a `wss://` relay |

Mode resolved at startup (`selectEffectiveNetworkProfile`, `apps/web/src/features/sessions/sessions.store.ts:217-230`) then fixed: pairing the proxy afterwards requires restarting the session. See [`network.md`](network.md), [`network-proxy.md`](network-proxy.md).

### Verifying

- in the guest: `ipconfig /all`;
- in LumiBoot: network badge (`data-testid="session-network-mode"`, `apps/web/src/components/session/SessionToolbar.tsx:62`), which shows the effective mode.

## Limitations

- software x86 emulation: slow boot;
- no write persistence;
- disks served in local development, unless a Range server is deployed;
- disk licence and security are the operator's responsibility.

Range transport: [`windows-7-streaming.md`](windows-7-streaming.md).
