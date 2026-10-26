# ADR 0004 — `vm-core` core

- Status: accepted
- Date: 2026-10-14

## Context

Shared responsibilities: lifecycle, engine resolution, errors.

## Decision

`@lumiboot/vm-core` separates five responsibilities:

- `contracts/`: `VMEngine`, `VMInstance`, configuration, capabilities and events;
- `lifecycle/`: states and transitions;
- `registry/`: engine resolution;
- `compatibility/`: engine ↔ system ↔ browser;
- `errors/` and `providers/`: normalized errors, unavailable engine.

`SessionLifecycle` guarantees a single instance, idempotent stop and `dispose()` after a stop or a partial failure; `tests/architecture.test.ts` forbids React/Zustand outside the UI.

## Consequences

- New system through the catalogue, never through UI conditions.
- Contracts and Zod schemas in `@lumiboot/contracts`.
- `vm-assets`, `vm-storage` and `vm-network` independent of the frontend.
