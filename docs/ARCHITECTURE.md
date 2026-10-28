# Architecture

## Overview

```text
React UI
  ├─ validated catalogue — @lumiboot/catalog + @lumiboot/contracts
  └─ SessionLifecycle / VMRegistry — @lumiboot/vm-core
       └─ lazy adapter → V86Provider, dynamic import
            ├─ assets and manifests — @lumiboot/vm-assets
            └─ network profile — @lumiboot/vm-network
                 ├─ v86 Fetch
                 ├─ WISP local proxy
                 └─ user WISP relay
```

VM, CPU and RAM run in the browser; the local proxy and the WISP relay carry network traffic.

## Components

| Path | Responsibility |
|---|---|
| `apps/web` | React/Vite, catalogue, system detail, session, dynamic provider import |
| `apps/network-proxy` | Go WISP V1 binary on loopback |
| `packages/contracts` | shared types and Zod schemas |
| `packages/catalog` | families, images, profiles, variants and availability |
| `packages/vm-core` | engine contracts, registry, compatibility and lifecycle |
| `packages/provider-v86` | v86 integration, console, readiness and network |
| `packages/vm-assets` | manifests, download, integrity and local disks |
| `packages/vm-storage` | versioned storage, quotas, backends; implemented, not wired to the sessions yet |
| `packages/vm-network` | network modes, profiles, capabilities and diagnostics |
| `images` | build scripts and metadata; large binaries ignored |
| `infra` | Nginx, Docker dev service, WISP relay |

## Architecture guardrails

`tests/architecture.test.ts` runs these rules from `tests/arch/dependency-graph.ts`, with no external dependency. A violation fails `pnpm test`, locally and in CI. The declared graph in `package.json` and the real import graph are acyclic; `findCycles` runs Tarjan's algorithm, reports a cycle and the suite fails.

### Package boundaries

`ALLOWED_INTERNAL_DEPS` pins the dependency direction:

```text
apps/web                → {catalog, contracts, provider-v86, vm-assets, vm-core, vm-network}
contracts               → ∅
catalog                 → contracts
vm-network              → contracts
vm-assets               → contracts
vm-storage              → ∅
vm-core                 → {contracts, vm-network}
provider-v86            → {contracts, vm-assets, vm-core, vm-network}
```

- `@lumiboot/contracts` is a leaf and imports no `@lumiboot/*` package.
- An undeclared `@lumiboot/*` dependency is a phantom dependency and fails the test.
- No package depends on `@lumiboot/web`, React or Zustand.
- Deep imports `@lumiboot/<pkg>/…` and relative paths crossing a package are forbidden. The public surface is `src/index.ts`.
- A new package declares its boundary; the test "each workspace package declares its boundaries" enforces it.

### Profile / `engineId` runtime compatibility

- The profile `engineId` exists in the catalogue (`packages/catalog/src/engines.ts`).
- The profile engine serves the system architecture, per the `ENGINE_ARCHITECTURES` test table.
- A `validated` profile relies on an `integrated` engine.
- `checkEngineCompatibility`, in `packages/vm-core/src/compatibility/`, checks `canRun`, the architecture when the engine declares one, and WebAssembly for every `browser` profile.

### Concurrency

`SessionLifecycle` and `VMRegistry` run against a fake engine, without disk:

- two concurrent `start()` calls create a single instance; the start is single-flight;
- two concurrent sessions stay isolated, with no shared state;
- `dispose()` during an in-flight `start()` releases the instance, without orphan;
- `register()` is idempotent for the same engine.

## Launch flow

1. The catalogue builds and validates the `OSDefinition` objects, an image plus a profile.
2. The UI creates a session from the system or variant id.
3. `VMRegistry` resolves the engine; the web adapter imports `@lumiboot/provider-v86` dynamically.
4. `V86Provider` checks the manifest and builds the emulator for the profile.
5. `running` follows a proof: Debian serial marker or first disk read (`disk-boot`).
6. Stop releases the network controller, emulator, listeners and session.

States: `idle → preparing → downloading → booting → running → stopping → stopped`, `error` on failure (`packages/vm-core/src/lifecycle/SessionState.ts`).

## Catalogue and availability

The engine comes from the profile. `getAggregatedAvailability` computes the state:

```text
imageRef present
+ compatible browser profile
+ integrated engine
+ validated = true
= ready
```

Each image × profile candidate is evaluated on its own. Required user media gives `resource-required`; an unproven `ready` falls back to the non-ready state of `packages/catalog/src/availability.ts`. Variants: [`systems.md`](systems.md#variant-order).

## Routes

| Route | View |
|---|---|
| `/` | catalogue |
| `/systems/:slug` | detail and variant selection |
| `/session/:id` | local session |

`/settings` has no route and returns page not found. Global configuration: `apps/web/public/lumiboot.config.json`.

## Functional state

- Integrated engine: v86, x86 32-bit.
- Debian 12: CLI, X11/Openbox and XFCE validated.
- Windows 7: Lite and Professional SP1, local RAW disks over HTTP Range.
- Windows 10 x86: boot proven on an operator RAW disk over HTTP Range, with `virtio-net` and the VirtIO NetKVM driver; guest connectivity untested, see [`images/windows-10-x86/README.md`](../images/windows-10-x86/README.md).
- Windows 11, Ubuntu, Fedora, Mint and macOS: catalogue only, engines or images missing.
- Network modes `offline`, `browser-fetch`, `local-proxy` and `user-relay` are implemented.

## Invariants

- No remote VM, VNC/RDP or orchestration API.
- No large disk or proprietary media in Git.
- No secret in a `VITE_*` variable or a public JSON file.
- No engine logic in React components.
- No `ready`, `running` or `connected` state without matching proof.
- No dependency outside the allowed boundaries and no cycle (`tests/architecture.test.ts`).
- A launch profile never pairs an architecture with an engine that does not serve it (`ENGINE_ARCHITECTURES`).
