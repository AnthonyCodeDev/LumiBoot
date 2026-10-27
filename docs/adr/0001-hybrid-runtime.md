# ADR 0001 — Local execution

- Status: accepted
- Date: 2026-10-14

## Context

32-bit x86 systems must run without a server-side compute host.

## Decision

The browser loads WebAssembly engines on demand, behind `VMEngine` and `VMRegistry` (`packages/vm-core/src/`). No remote hypervisor, VNC/RDP or orchestration API is involved. Downloadable assets and a local network helper are allowed; a server-side VM is not.

## Consequences

- The profile selects the engine and its configuration. Compatibility is checked before start, with no simulated session.
- The engine, its workers and its listeners are always released.
- A WISP relay is optional and never hosts execution.
