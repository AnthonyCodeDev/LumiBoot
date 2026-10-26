# LumiBoot

React catalogue of x86 systems in the browser (**v86 / WebAssembly, 32-bit**). No virtualization backend; no simulated state.

## Available systems

| System | Variants | Media | RAM |
|---|---|---|---|
| Debian 12 | XFCE, X11/Openbox, CLI | local ext4 image (kernel + initrd), 4 / 3 / 3 GiB | 1 GiB / 1 GiB / 512 MiB |
| Windows 7 | Professional SP1, Lite | local RAW disks (32 / 16 GiB) | 1536 / 1024 MiB |
| Windows 10 x86 | 32-bit | local RAW disk (40 GiB) | 2048 MiB |

Images and proprietary media live outside Git. `ready`: `imageRef` + `browser` profile + `integrated` engine + `validated: true`, same candidate (`packages/catalog/src/systems.ts`).

## Getting started

Node.js ≥ 20 (`engines`), pnpm 9.14.2 (`packageManager`).

```bash
pnpm install
pnpm assets:prepare
pnpm dev
```

`http://127.0.0.1:5173`.

`assets:prepare`: `v86.wasm` from the npm package + pinned BIOS, sizes and SHA-256 (`scripts/v86-assets.lock.json`). Debian: [`images/debian-12-i386/README.md`](images/debian-12-i386/README.md).

## Commands

```bash
pnpm build          # recursive tsc --noEmit + Vite bundle
pnpm typecheck      # tsc --noEmit
pnpm lint           # ESLint
pnpm format:check   # Prettier (pnpm format rewrites)
pnpm test           # Vitest
pnpm test:e2e       # Playwright, port 5200
pnpm assets:check   # v86 binary integrity
```

`pnpm preview`: build on 5173. `pnpm test:watch`: Vitest in watch mode.

Real boots, opt-in (several GiB of assets):

```powershell
$env:VM_E2E_ASSETS='1'
pnpm test:e2e
```

E2E: `5200`; dev: `5173` (`apps/web/vite.config.ts`, `playwright.config.ts`).

## Architecture

| Path | Role |
|---|---|
| `apps/web` | React/Vite, catalogue, sessions, dynamic provider import |
| `apps/network-proxy` | local WISP V1 proxy in Go (loopback `127.0.0.1:37892`) |
| `packages/contracts` | types and Zod schemas |
| `packages/catalog` | images, profiles, engines, variants, availability |
| `packages/vm-core` | engine contracts, registry, lifecycle |
| `packages/provider-v86` | v86 integration, readiness, console, network |
| `packages/vm-assets` | manifests, integrity, local disks |
| `packages/vm-storage` | versioned storage, quotas; isolated package, no consumer |
| `packages/vm-network` | modes, profiles, capabilities, diagnostics |
| `images` | scripts and manifests; binaries ignored |
| `infra` | Nginx, Docker dev, WISP relay |

UI → `VMRegistry` → dynamic import of `provider-v86` → manifest → emulator. `running`: Debian guest marker or disk read (`disk-boot`). Stop: `stop()`, `dispose()`. Details: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Network

- `offline`: no NIC;
- `browser-fetch`: HTTP 80, CORS;
- `local-proxy`: outbound TCP through the local binary on `127.0.0.1:37892`, paired from its console;
- `user-relay`: user-provided WISP.

Profile fixed before v86; changing it means a new session. Public config: `apps/web/public/lumiboot.config.json`. See [`docs/network.md`](docs/network.md), [`docs/network-proxy.md`](docs/network-proxy.md).

## Local media

- Debian: `images/debian-12-i386/build.sh` → `apps/web/public/images/<ref>/` (`rootfs.img`, `vmlinuz-686`, `initrd.img`, `manifest.json`).
- Windows 7: `images/<ref>/disk.img` + `pnpm assets:windows7:prepare`; Vite middleware, in-place HTTP Range.
- Windows 10: `images/windows-10-x86/disk.img` + `pnpm assets:windows10:prepare`.
- `pnpm assets:windows7:serve`: disk + v86 binaries on loopback, token, no copy into `public/`.

See [`docs/windows-7.md`](docs/windows-7.md), [`docs/windows-10.md`](docs/windows-10.md), [`docs/LICENSES.md`](docs/LICENSES.md).

## Documentation

- [`docs/AGENT_BRIEF.md`](docs/AGENT_BRIEF.md) — technical contribution
- [`docs/system-variants.md`](docs/system-variants.md) — variants and order
- [`docs/SECURITY.md`](docs/SECURITY.md) — security invariants
- [`docs/adr/`](docs/adr/) — architecture decisions
