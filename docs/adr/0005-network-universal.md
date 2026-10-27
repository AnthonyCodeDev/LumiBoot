# ADR 0005 — Shared network layer

- Status: accepted
- Date: 2026-10-14

## Context

Network modes must translate into `net_device` without leaking the abstraction.

## Decision

`@lumiboot/vm-network` describes profiles, capabilities, diagnostics and lifecycle independently of the engine. `provider-v86` translates the profile into `net_device`.

| Mode | Transport |
|---|---|
| `offline` | no NIC |
| `browser-fetch` | v86 Fetch; HTTP 80, CORS, no HTTPS |
| `local-proxy` | WISP V1 to the local loopback proxy |
| `user-relay` | user-provided WISP relay |

Configured profile, theoretical capability and probe-verified connectivity stay distinct; `fullInternet` defaults to `false`.

## Consequences

- The profile is fixed before start; any change recreates the session.
- No public relay is provided.
- Traffic counters do not prove connectivity.
- Details: [`../network/network.md`](../network/network.md).
