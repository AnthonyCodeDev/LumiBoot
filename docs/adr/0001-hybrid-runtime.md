# ADR 0001 — Local execution

- Status: accepted
- Date: 2026-10-14

## Context

32-bit x86 OSes run without a server-side compute host.

## Decision

WebAssembly engines loaded on demand in the browser, behind `VMEngine` and `VMRegistry` (`packages/vm-core/src/`). No remote hypervisor, VNC/RDP or orchestration API: downloadable assets and a local network helper are tolerated, never a server VM.

## Consequences

- The profile picks the engine and its configuration; compatibility checked before start, with no simulated session.
- Mandatory release of the engine, workers and listeners.
- Optional WISP relay, without moving execution.
