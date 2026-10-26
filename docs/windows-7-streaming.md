# HTTP Range streaming of local disks

Pipeline serving a RAW disk without copying it into `public/` or loading it into memory.

## Components

| File | Role |
|---|---|
| `scripts/prepare-windows7-asset.mjs` | manifest, provenance and streaming SHA-256 |
| `scripts/lib/disk-asset-dev.mjs` | manifest discovery and Vite middleware |
| `scripts/lib/range-server.mjs` | shared HTTP Range implementation |
| `scripts/serve-windows7-asset.mjs` | standalone loopback server with token |
| `packages/vm-assets/src/local-disk.ts` | manifest validation |

## HTTP contract

v86 probes the size with `Range: bytes=0-0` then reads by ranges. The server returns `206` with exact `Content-Range`, `Content-Length` and `Accept-Ranges: bytes`, `416` and `Content-Range: bytes */<size>` for an unsatisfiable range, never `Content-Encoding`. A `200` response to a Range request is rejected by the v86 async reader; multiple ranges are merged into `multipart/byteranges` (32 maximum).

## Standalone server

```bash
pnpm assets:windows7:serve
# or
node scripts/serve-windows7-asset.mjs \
  --manifest images/windows-7-x86/manifest.json \
  --port 37893
```

Defaults: `images/windows-7-pro-sp1-x86/manifest.json`, `127.0.0.1:37893`, random 24-byte token (hex) accepted as `?token=` or `X-Lumiboot-Token`, applied to the disk, manifest and v86 binary URLs. `--no-token`, `--token <value>` (8 characters minimum), `--source <file>`, `--expose` (non-loopback, downloadable disk).

## Verification

```bash
pnpm assets:windows7:check
pnpm exec vitest run tests/prepare-windows7-asset.test.ts tests/range-server.test.ts
```

COOP/COEP is not required by v86 0.5.471; `LUMIBOOT_COOP_COEP=1` enables them on the dev server and the preview (`apps/web/vite.config.ts:12,19-27`).
