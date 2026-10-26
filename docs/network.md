# Network

`@lumiboot/vm-network`: modes, profiles, capabilities, diagnostics and lifecycle; `provider-v86` translates the selected profile into `net_device`.

## Modes

| Mode | Transport | Limits |
|---|---|---|
| `offline` | none | no NIC |
| `browser-fetch` | v86 Fetch | HTTP 80 only, CORS, no HTTPS, UDP or ICMP |
| `local-proxy` | WISP V1 to `127.0.0.1:37892` | pairing required, outbound TCP only |
| `user-relay` | WISP over `wss://` | relay provided and administered by the user |

Adapter imposed by the catalogue profile: Windows 7 `ne2k` (RTL8029, driver to install in the image, [`windows-7.md`](windows-7.md)); Windows 10 x86 `virtio-net` (PCI `0x1AF4:0x1041`, VirtIO NetKVM driver required, guest connectivity not tested, [`windows-10.md`](windows-10.md)); Debian `virtio-net` (6.x kernel).

## Evidence level

- Configured: valid profile, selected.
- Supported: `capabilitiesForMode()` declares a theoretical capability.
- Verified: probe run inside the guest and successful.

An open WebSocket and non-zero `txBytes`/`rxBytes` counters do not prove Internet access; `fullInternet` stays `false` by default.

## Configuration

`apps/web/public/lumiboot.config.json`, loaded at startup; one profile per system overrides the default:

```json
{
  "version": 1,
  "network": {
    "defaultProfile": { "mode": "browser-fetch" },
    "systems": {
      "debian-12-i386": { "mode": "browser-fetch" }
    }
  },
  "proxy": { "enabled": true }
}
```

No secrets. The profile is applied before v86 is created; changing the mode requires a new session.

### User WISP relay

```json
{ "mode": "user-relay", "relayUrl": "wss://relay.example.org/" }
```

`wss://` mandatory; `ws://` tolerated only in development on localhost. A plain WebSocket is not necessarily a WISP relay.

### Local proxy

The frontend detects the proxy, requests pairing, verifies the token (`GET /api/session/verify`), then substitutes `local-proxy` for any base mode except `offline` and `user-relay` (`selectEffectiveNetworkProfile`, `packages/vm-network/src/proxy.ts:142-159`); a `local-proxy` without a proxy falls back to `browser-fetch`. See [`network-proxy.md`](network-proxy.md).

## Verification from Debian

```bash
ip -br addr
getent hosts deb.debian.org
curl -I http://deb.debian.org/
curl -I https://deb.debian.org/
```

`browser-fetch`: HTTP only, subject to CORS. Valid proxy or WISP relay: HTTPS and outbound TCP. UDP and ICMP are not advertised.

## Lifecycle

One session, one controller: `start(signal?: AbortSignal)`, `stop()`, `dispose()` (idempotent). Disposal removes v86 listeners and closes the transport.

Decisions: [`adr/0005-network-universal.md`](adr/0005-network-universal.md), [`adr/0007-network-proxy.md`](adr/0007-network-proxy.md).
