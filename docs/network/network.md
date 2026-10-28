# Network

`@lumiboot/vm-network` owns modes, profiles, capabilities, diagnostics and lifecycle. `provider-v86` translates the selected profile into `net_device`.

## Modes

| Mode | Transport | Limits |
|---|---|---|
| `offline` | none | no NIC |
| `browser-fetch` | v86 Fetch | HTTP 80 only, CORS, no HTTPS, UDP or ICMP |
| `local-proxy` | WISP V1 to `127.0.0.1:37892` | pairing required, outbound TCP only |
| `user-relay` | WISP over `wss://` | relay provided and administered by the user |

The catalogue profile imposes the adapter. Windows 7 uses `ne2k`, the RTL8029 chip, and the driver must be installed in the image; see [`windows-7-pro-sp1-x86/README.md`](../../images/windows-7-pro-sp1-x86/README.md). Windows 10 x86 uses `virtio-net`, PCI `0x1AF4:0x1041`, which requires the VirtIO NetKVM driver; guest connectivity is untested, see [`windows-10-x86/README.md`](../../images/windows-10-x86/README.md). Debian uses `virtio-net` on its 6.x kernel.

## Evidence level

- Configured: valid profile, selected.
- Supported: `capabilitiesForMode()` declares a theoretical capability.
- Verified: probe run inside the guest and successful.

An open WebSocket and non-zero `txBytes`/`rxBytes` counters do not prove Internet access. `fullInternet` stays `false` by default.

## Configuration

`apps/web/public/lumiboot.config.json` loads at startup and holds no secrets. One profile per system overrides the default:

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

The profile applies before v86 is created; a mode change requires a new session.

### User WISP relay

```json
{ "mode": "user-relay", "relayUrl": "wss://relay.example.org/" }
```

`wss://` is mandatory; `ws://` is tolerated only in development on localhost. A plain WebSocket is not necessarily a WISP relay.

### Local proxy

The frontend detects the proxy, requests pairing, verifies the token with `GET /api/session/verify`, then substitutes `local-proxy` for any base mode except `offline` and `user-relay`; see `selectEffectiveNetworkProfile` in `packages/vm-network/src/proxy.ts`. A `local-proxy` without a proxy falls back to `browser-fetch`. See [`network-proxy.md`](network-proxy.md).

## Verification from Debian

```bash
ip -br addr
getent hosts deb.debian.org
curl -I http://deb.debian.org/
curl -I https://deb.debian.org/
```

`browser-fetch` serves HTTP only, subject to CORS. A valid proxy or WISP relay gives HTTPS and outbound TCP. UDP and ICMP are not advertised.

## Lifecycle

One session, one controller: `start(signal?: AbortSignal)`, `stop()`, `dispose()`. Both `stop()` and `dispose()` are idempotent. Disposal removes v86 listeners and closes the transport.

Decisions: [`adr/0005-network-universal.md`](../adr/0005-network-universal.md), [`adr/0007-network-proxy.md`](../adr/0007-network-proxy.md).
