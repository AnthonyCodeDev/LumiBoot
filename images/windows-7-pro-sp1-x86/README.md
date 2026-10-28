# Windows 7 Professional SP1 x86

Two validated variants, BIOS-booted from local RAW disks. No disk, ISO or license key is shipped or versioned by this repository: `images/<ref>/disk.img` and `provenance.txt` are Git-ignored, and the versioned `manifest.json` holds no absolute machine path.

| Variant | Reference | Disk | RAM | Order |
|---|---|---:|---:|---:|
| Professional SP1 x86 | `windows-7-pro-sp1-x86` | 32 GiB | 1536 MiB | 1, default |
| Lite x86 | `windows-7-x86` | 16 GiB | 1024 MiB | 2, parent |

The Lite variant has its own short page: [`windows-7-x86/README.md`](../windows-7-x86/README.md).

## What you must provide

An installed 32-bit Windows 7 RAW disk, bootable in BIOS/MBR, plus a valid licence for the guest; a UEFI/GPT disk does not boot. Media, ISO and key are the operator's responsibility; the terms are summarised in [`docs/LICENSES.md`](../../docs/LICENSES.md).

1. Put the RAW disk here: `disk.img`.
2. Regenerate the manifest: `pnpm assets:windows7:prepare`.

`manifest.json` describes size, BIOS boot over HTTP Range and the URL `/images/windows-7-pro-sp1-x86/disk.img`; it stores no absolute path.

## Preparing a disk

```bash
node scripts/prepare-windows7-asset.mjs \
  --source images/windows-7-pro-sp1-x86/disk.img \
  --ref windows-7-pro-sp1-x86 \
  --display-name "Windows 7 Professionnel SP1 x86" \
  --architecture i386 --memory-mib 1536 --vga-mib 16 \
  --out images/windows-7-pro-sp1-x86
```

The source is opened read-only and hashed in 8 MiB streaming blocks; only `manifest.json` and `provenance.txt` are written. `--skip-hash` records size and `mtime` instead of a SHA-256, `--resume` reuses an existing SHA-256 when size and `mtime` match. `--force` overwrites an existing manifest and is mandatory otherwise. `--check` verifies without writing, `--source` being required for an external disk. `--copy-to` makes a verified copy, refused onto the source or into `public/`.

`pnpm assets:windows7:check` equals `--check`. A disk outside the repository gets a `source.external` marker and no recorded path: `--source` becomes mandatory for any verification.

## Development

`pnpm dev` loads the `scripts/lib/disk-asset-dev.mjs` middleware declared in `apps/web/vite.config.ts`. It discovers every `images/<ref>/manifest.json` with `boot.mode === 'disk-boot'` and serves the disk in place on `/images/<ref>/disk.img` over HTTP Range `206`, plus the public manifest without `source` or `provenance`. The disk is attached as `hda.async`, never as a CD-ROM. v86 writes stay in memory and vanish on stop; the source file is untouched.

## Readiness

No guest marker: `disk-boot` switches to `running` on the first real IDE read of the disk, an `ide-read-end` event on channel 0 with bytes > 0, handled by `#onDiskRead` in `packages/provider-v86/src/v86-instance.ts`. The timeout is 300 s, set by `diskBootReadiness` in `packages/catalog/src/profiles.ts`. That proof attests booting, not a working desktop; the E2E test covers the VGA canvas.

```powershell
$env:VM_E2E_ASSETS='1'
pnpm exec playwright test tests/e2e/windows7-desktop.spec.ts
```

Playwright serves the app on port `5200`. Without `VM_E2E_ASSETS=1`, the real tests are skipped, since they need the 16 and 32 GiB disks.

## Network: Internet inside the guest

**NE2000 (`ne2k`)** adapter: profiles declare `hardwareProfile: { ...pcHardware('ne2k'), acpi: true }` in `packages/catalog/src/profiles.ts`, translated into `net_device.type = 'ne2k'` by `toV86NetworkDeviceType` from `packages/provider-v86/src/network/V86NetworkAdapter.ts`. Windows 7 ships no inbox driver for this card: without an installed NE2000/RTL8029 driver the guest reports "No connections are available", whatever the network mode; see the v86 documentation, [§5.3 Enabling networking](https://github.com/copy/v86/blob/master/docs/windows-nt.md).

The driver must sit **inside `disk.img`**: the disk is served read-only, so the installation happens offline in QEMU, before preparing or regenerating the manifest. Windows 10 x86 uses `virtio-net`; see [`windows-10-x86/README.md`](../windows-10-x86/README.md).

### Installing the driver offline with QEMU

```bash
qemu-system-i386 \
  -drive file=images/windows-7-pro-sp1-x86/disk.img,format=raw,if=ide \
  -m 1536 \
  -nic user,model=ne2k_pci \
  -cdrom drivers-ne2000.iso
```

1. mount the NE2000/RTL8029 ISO, or its extracted folder;
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

`net_device` combines the profile adapter `ne2k` with the mode transport, and is absent only in `offline`; see `toV86NetworkDevice` and `toV86NetworkDeviceType` in `packages/provider-v86/src/V86Provider.ts`.

| Effective mode | Guest network |
|---|---|
| `offline` | no NIC |
| `browser-fetch` | ne2k + fetch backend: HTTP 80 only, CORS |
| `local-proxy` | ne2k + WISP to the paired proxy, outbound TCP |
| `user-relay` | ne2k + WISP to a `wss://` relay |

The mode is resolved at startup by `selectEffectiveNetworkProfile` in `apps/web/src/features/sessions/sessions.store.ts`, then fixed: pairing the proxy afterwards requires restarting the session. See [`network.md`](../../docs/network/network.md), [`network-proxy.md`](../../docs/network/network-proxy.md).

### Verifying

- in the guest: `ipconfig /all`;
- in LumiBoot: the network badge, `data-testid="session-network-mode"` in `apps/web/src/components/session/SessionToolbar.tsx`, which shows the effective mode.

## Range transport

A RAW disk is served without copying it into `public/` or loading it into memory.

| File | Role |
|---|---|
| `scripts/prepare-windows7-asset.mjs` | manifest, provenance and streaming SHA-256 |
| `scripts/lib/disk-asset-dev.mjs` | manifest discovery and Vite middleware |
| `scripts/lib/range-server.mjs` | shared HTTP Range implementation |
| `scripts/serve-windows7-asset.mjs` | standalone loopback server with token |
| `packages/vm-assets/src/local-disk.ts` | manifest validation |

### HTTP contract

v86 probes the size with `Range: bytes=0-0`, then reads by ranges. The server answers `206` with exact `Content-Range`, `Content-Length` and `Accept-Ranges: bytes`, and `416` with `Content-Range: bytes */<size>` when the range is unsatisfiable. It never sets `Content-Encoding`. The v86 async reader rejects a `200` answer to a Range request. Up to 32 ranges are merged into `multipart/byteranges`.

### Standalone server

```bash
pnpm assets:windows7:serve
# or
node scripts/serve-windows7-asset.mjs \
  --manifest images/windows-7-x86/manifest.json \
  --port 37893
```

Defaults: `images/windows-7-pro-sp1-x86/manifest.json`, `127.0.0.1:37893`, and a random 24-byte token in hex, accepted as `?token=` or `X-Lumiboot-Token`. The token covers the disk, manifest and v86 binary URLs. Flags: `--no-token`, `--token <value>` with 8 characters minimum, `--source <file>`, `--expose` for a non-loopback server that offers the disk for download.

### Verification

```bash
pnpm assets:windows7:check
pnpm exec vitest run tests/prepare-windows7-asset.test.ts tests/range-server.test.ts
```

v86 0.5.471 does not require COOP/COEP. `LUMIBOOT_COOP_COEP=1` enables them on the dev server and the preview, configured in `apps/web/vite.config.ts`.

## Limitations

- software x86 emulation: slow boot;
- no write persistence;
- disks served in local development, unless a Range server is deployed;
- disk licence and security are the operator's responsibility.
