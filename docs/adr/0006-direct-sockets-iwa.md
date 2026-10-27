# ADR 0006 — Direct Sockets in an Isolated Web App

- Status: not implemented
- Date: 2026-10-15

## Context

The `direct-sockets` permission exists only in a signed and installed Chrome Isolated Web App, not in a web page or a PWA.

## Decision

No `direct-sockets` transport is implemented. Its place would be `@lumiboot/vm-network`, not `VMEngine`: a browser IP stack would convert guest Ethernet frames into sockets.

## Consequences

- No ICMP, no raw IP sockets.
- Signed IWA distribution to maintain.
- Outbound traffic from the user's IP.
- Security, licence and distribution validation required.
