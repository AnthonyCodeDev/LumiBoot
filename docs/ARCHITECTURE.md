# Architecture

## Overview

```text
React UI
  ├─ validated catalogue (@lumiboot/catalog + @lumiboot/contracts)
  └─ SessionLifecycle / VMRegistry (@lumiboot/vm-core)
       └─ lazy adapter → V86Provider (dynamic import)
            ├─ assets and manifests (@lumiboot/vm-assets)
            └─ network profile (@lumiboot/vm-network)
                 ├─ v86 Fetch
                 ├─ WISP local proxy
                 └─ user WISP relay
```

VM, CPU and RAM run in the browser; local proxy and WISP relay: network only.

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
| `packages/vm-storage` | versioned storage, quotas, backends; no consumer |
| `packages/vm-network` | network modes, profiles, capabilities and diagnostics |
| `images` | build scripts and metadata; large binaries ignored |
| `infra` | Nginx, Docker dev service, WISP relay |

## Architecture guardrails

Enforced by `tests/architecture.test.ts` (`tests/arch/dependency-graph.ts`, no external dependency); a violation fails `pnpm test`, locally and in CI.

### Package boundaries

Dependency direction pinned in `ALLOWED_INTERNAL_DEPS`:

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

- `@lumiboot/contracts` is a **leaf**: no `@lumiboot/*`;
- out-of-boundary dependency or undeclared `@lumiboot/*` forbidden (no phantom dependency);
- no package depends on `@lumiboot/web`, React or Zustand;
- deep imports `@lumiboot/<pkg>/…` and relative paths crossing a package are forbidden; public surface = `src/index.ts`;
- adding a package requires **declaring its boundary** (test "each workspace package declares its boundaries").

### Cycles

Declared graph (`package.json`) and the actual import graph are acyclic (Tarjan, `findCycles`); a cycle fails the test suite.

### Profile / `engineId` runtime compatibility

- profile `engineId` present in the catalogue (`packages/catalog/src/engines.ts`);
- system architecture served by the profile engine (test table `ENGINE_ARCHITECTURES`);
- `validated` profile backed by an `integrated` engine;
- `checkEngineCompatibility` (`packages/vm-core/src/compatibility/`) checks `canRun`, the architecture when the engine declares one, and WebAssembly for every `browser` profile.

### Concurrency

Checked on `SessionLifecycle`/`VMRegistry` with a fake engine, no disk:

- two concurrent `start()` calls → a single instance (single-flight);
- two concurrent sessions isolated: no shared state;
- `dispose()` during an in-flight `start()` releases the instance, without orphan;
- `register()` idempotent for the same engine.

## Launch flow

1. The catalogue builds and validates the `OSDefinition` objects (image + profile).
2. The UI creates a session from the system or variant id.
3. `VMRegistry` resolves the engine; the web adapter imports `@lumiboot/provider-v86` dynamically.
4. `V86Provider` checks the manifest and builds the emulator according to the profile.
5. `running` after proof: Debian serial marker or first disk read (`disk-boot`).
6. Stop: network controller, emulator, listeners and session released.

States: `idle → preparing → downloading → booting → running → stopping → stopped`, `error` on failure (`packages/vm-core/src/lifecycle/SessionState.ts`).

## Catalogue and availability

The engine comes from the profile. Availability is computed by `getAggregatedAvailability`, never entered by hand:

```text
imageRef present
+ compatible browser profile
+ integrated engine
+ validated = true
= ready
```

Each image × profile candidate is evaluated separately. User media required → `resource-required`; an unproven `ready` is downgraded to the non-ready state of `packages/catalog/src/availability.ts`. Variants: [`system-variants.md`](system-variants.md).

## Routes

| Route | View |
|---|---|
| `/` | catalogue |
| `/systems/:slug` | detail and variant selection |
| `/session/:id` | local session |

No Settings route (`/settings` → page not found). Global configuration: `apps/web/public/lumiboot.config.json`.

## Functional state

- Integrated engine: v86, x86 32-bit.
- Debian 12: CLI, X11/Openbox and XFCE validated.
- Windows 7: Lite and Professional SP1, local RAW disks over HTTP Range.
- Windows 10 x86: real boot proven (operator RAW disk over HTTP Range, `virtio-net` + VirtIO NetKVM driver); guest connectivity not covered by a test. See [`windows-10.md`](windows-10.md).
- Windows 11, Ubuntu, Fedora, Mint and macOS: catalogue only, engines or images missing.
- Network: `offline`, `browser-fetch`, `local-proxy`, `user-relay` implemented.

## Invariants

- No remote VM, VNC/RDP or orchestration API.
- No large disk or proprietary media in Git.
- No secret in a `VITE_*` variable or a public JSON file.
- No engine logic in React components.
- No `ready`, `running` or `connected` state without matching proof.
- No cross-package dependency outside the allowed boundaries, no cycle between packages (`tests/architecture.test.ts`).
- A launch profile never pairs an architecture with an engine that does not serve it (`ENGINE_ARCHITECTURES`).
