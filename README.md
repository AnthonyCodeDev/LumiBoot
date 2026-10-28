# LumiBoot

**The first launcher that boots real x86 operating systems in a browser tab.**

LumiBoot boots x86 operating systems inside a browser tab. The CPU is emulated in WebAssembly by
v86, the firmware is a real BIOS, and disks are read over HTTP Range. No backend sits between the
browser and the guest: the machine boots from BIOS to kernel to desktop, with networking when the
selected mode provides it. No system image is shipped; you supply the media.

[![CI](https://github.com/AnthonyCodeDev/LumiBoot/actions/workflows/ci.yml/badge.svg)](https://github.com/AnthonyCodeDev/LumiBoot/actions/workflows/ci.yml)
[![Hygiene](https://github.com/AnthonyCodeDev/LumiBoot/actions/workflows/hygiene.yml/badge.svg)](https://github.com/AnthonyCodeDev/LumiBoot/actions/workflows/hygiene.yml)
[![Security](https://github.com/AnthonyCodeDev/LumiBoot/actions/workflows/security.yml/badge.svg)](https://github.com/AnthonyCodeDev/LumiBoot/actions/workflows/security.yml)

## Systems

| System         | Variants                 | Guest RAM               | Media                             |
| -------------- | ------------------------ | ----------------------- | --------------------------------- |
| Debian 12      | XFCE / X11-Openbox / CLI | 1 GiB / 1 GiB / 512 MiB | local ext4 image built by script  |
| Windows 7      | Professional SP1 / Lite  | 1536 / 1024 MiB         | RAW disk provided by the operator |
| Windows 10 x86 | 32-bit                   | 2048 MiB                | RAW disk provided by the operator |

Without a registered image, a system is listed as unavailable.

## Requirements

- Node.js >= 20.
- pnpm 9.14.2, enabled with `corepack enable`.
- Go stable, only to build `apps/network-proxy`.
- A recent Chrome, Edge or Firefox.
- Linux or WSL2 to rebuild the Debian images.

## Quick start

```bash
corepack enable
pnpm install
pnpm assets:prepare
pnpm dev
```

Open `http://127.0.0.1:5173`. `assets:prepare` fetches `v86.wasm` and the pinned BIOS files, verified by size and SHA-256 against `scripts/v86-assets.lock.json`.

## Media

No disk, ISO or license key is shipped or downloaded: register your own image before starting a session.

| System         | Required media                     | Register with                    |
| -------------- | ---------------------------------- | -------------------------------- |
| Debian 12      | built rootfs, kernel and initrd    | `images/debian-12-i386/build.sh` |
| Windows 7      | installed 32-bit BIOS/MBR RAW disk | `pnpm assets:windows7:prepare`   |
| Windows 10 x86 | installed 32-bit BIOS/MBR RAW disk | `pnpm assets:windows10:prepare`  |

```bash
sudo ./images/debian-12-i386/build.sh
pnpm assets:windows7:prepare --source images/windows-7-pro-sp1-x86/disk.img
pnpm assets:windows10:prepare --source images/windows-10-x86/disk.img
```

Disks are read-only: guest writes stay in memory and are lost on stop.

Per-system instructions: [`docs/systems.md`](docs/systems.md).

## Commands

```bash
pnpm build                 # recursive build + Vite bundle
pnpm typecheck             # tsc --noEmit
pnpm lint                  # ESLint
pnpm format:check          # Prettier check; pnpm format rewrites
pnpm test                  # Vitest
pnpm test:e2e              # Playwright, port 5200
pnpm assets:check          # v86 binary integrity
pnpm assets:windows7:prepare|check
pnpm assets:windows10:prepare|check
```

The real boot tests need several GiB of media and stay opt-in: `VM_E2E_ASSETS=1 pnpm test:e2e`. They are skipped otherwise.

## Architecture

| Path                    | Role                                                                            |
| ----------------------- | ------------------------------------------------------------------------------- |
| `apps/web`              | web interface, sessions, dynamic provider loading                               |
| `apps/network-proxy`    | local WISP V1 proxy in Go (`127.0.0.1:37892`)                                   |
| `packages/contracts`    | types and Zod schemas                                                           |
| `packages/catalog`      | images, profiles, engines, variants, availability                               |
| `packages/vm-core`      | engine contracts, registry, lifecycle                                           |
| `packages/provider-v86` | v86 integration, readiness, console, network                                    |
| `packages/vm-assets`    | manifests, integrity, local disks                                               |
| `packages/vm-storage`   | versioned storage, quotas, backends; implemented, not wired to the sessions yet |
| `packages/vm-network`   | modes, profiles, capabilities, diagnostics                                      |
| `images`                | build scripts and manifests; binaries ignored                                   |
| `infra`                 | nginx, Docker dev, WISP relay                                                   |

UI → `VMRegistry` → dynamic import of `provider-v86` → manifest → emulator. Stop calls `stop()` then `dispose()`. Design notes: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Network

- `offline`: no NIC.
- `browser-fetch`: HTTP port 80 with CORS.
- `local-proxy`: outbound TCP through the local binary on `127.0.0.1:37892`, paired from its console.
- `user-relay`: a WISP relay you provide.

The profile is fixed before v86 starts; changing it requires a new session. `local-proxy` needs the network client from GitHub Releases, extracted into `apps/web/public/downloads/` for development. References: [`docs/network/network.md`](docs/network/network.md), [`docs/network/network-proxy.md`](docs/network/network-proxy.md).

## Security

- Proprietary images are never distributed by this repository.
- In production, the nginx configuration in [`infra/nginx/site.conf`](infra/nginx/site.conf) returns 404 for any Windows image under `/images/`; the development middleware that serves disks in place exists locally only.
- Origins and response headers are set in `infra/nginx`.
- Secrets are supplied only through environment variables.
- Report vulnerabilities privately, as described in [`docs/SECURITY.md`](docs/SECURITY.md) or through GitHub Security Advisories.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Contributions stay under the project license and keep the attribution to the original author; re-publication under another name is not allowed. Run `pnpm lint`, `pnpm typecheck` and `pnpm test` before a pull request.

## License

Released under the LumiBoot Source-Available License 1.0 ([`LICENSE`](LICENSE)): source-available, not OSI open source; personal, educational and evaluation use is allowed with attribution, and modified distributions keep the same license.
Third-party components keep their own terms, listed in [`docs/LICENSES.md`](docs/LICENSES.md).
Commercial use requires a paid license from the author.
