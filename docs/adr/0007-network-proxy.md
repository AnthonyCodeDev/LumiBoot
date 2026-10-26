# ADR 0007 — Local network proxy

- Status: accepted
- Date: 2026-10-15

## Context

v86 0.5.471 sends neither a custom header nor a WebSocket subprotocol: the token travels in the URL.

## Decision

`apps/network-proxy` exposes WISP V1 on `127.0.0.1:37892` in cross-platform Go, outbound TCP only, no VM. The browser requests a pairing, the user approves the code in the console, then exchanges the authorization for a hashed token bound to the origin.

## Consequences

- Loopback listener by default; exact origin and token mandatory.
- Private networks, loopback and cloud metadata blocked after DNS resolution.
- Quotas, timeouts, revocation, graceful shutdown; UDP refused, no inbound traffic, ICMP not guaranteed.
- Protocol: [`../proxy-contract.md`](../proxy-contract.md); operations: [`../network-proxy.md`](../network-proxy.md).
