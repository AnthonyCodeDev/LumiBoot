# ADR 0003 — No remote VM infrastructure

- Status: accepted
- Date: 2026-10-14

## Context

A VM backend would impose compute, secrets and server state, against ADR 0001.

## Decision

No remote compute, no orchestration API, no remote console: engines in the browser, `stop()` then `dispose()`.

Allowed, without running a VM:

- static hosting of engines and images;
- native network proxy on loopback on the user's machine;
- WISP relay explicitly administered by the user.

## Consequences

- No infrastructure secret in the frontend.
- "Available" or "connected" is never deduced from a configuration.
- Any extension keeps execution local.
