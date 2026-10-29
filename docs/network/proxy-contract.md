# Local network proxy contract

Base: `http://127.0.0.1:37892`. Responses are JSON, except the WebSocket upgrade. Sensitive routes require an allowed origin.

## Endpoints

| Method and route | Success | Role |
|---|---|---|
| `GET /health` | `200` | `status`, `version`, `wispVersion`, `uptimeSeconds`, `activeConnections`, `counters` |
| `POST /api/pair/request` | `201` | creates `{pairingId,userCode,expiresAt}` |
| `GET /api/pair/status?id=…` | `200` | `{status,expiresAt}`: `pending`, `approved` or `denied` |
| `POST /api/pair/exchange` | `200` | exchanges `{pairingId}` for `{token,expiresAt}` |
| `GET /api/session/verify?token=…` | `200` | authenticated proof `{ok:true,expiresAt}` |
| `POST /api/session/revoke` | `200` | revokes `{token}` and closes the related streams |
| `GET /wisp/?token=…` | `101` | WISP V1 upgrade |

Errors: `400` invalid JSON, unknown fields refused; `403` origin refused or exchange impossible. `401` invalid token on `verify` and `403` on `/wisp/`; `404` unknown or expired pairing/session; `429` too many requests, 64 pending and 8 per origin.

## Pairing

- A pairing request lives 10 minutes by default.
- Exchange needs the same origin and console approval; the pairing id is single-use.
- The token holds 32 random bytes in base64url, is returned once, stored hashed, bound to the origin, and lives 24 hours by default.

`connected` appears only after a successful `GET /api/session/verify`. A valid `/health` leaves `pairing-required`.

## WISP V1

Frame: `[type:u8][stream_id:u32 little-endian][payload]`. The CONNECT payload is `[stream_type:u8][port:u16 LE][hostname UTF-8]`.

| Type | Code | Support |
|---|---:|---|
| CONNECT | `0x01` | TCP only |
| DATA | `0x02` | yes |
| CONTINUE | `0x03` | yes; initial window announced at handshake |
| CLOSE | `0x04` | yes |
| INFO V2 | `0x05` | ignored |

UDP closes with code `0x41`. The proxy advertises `wispVersion: 1`; any other version is refused with `PROXY_WISP_VERSION`.

## Destination policy

Every CONNECT is validated in `apps/network-proxy/internal/security/policy.go` before the dial; a refusal closes the stream with `0x48`.

| Rule | Detail |
|---|---|
| Sensitive ports | `25` (SMTP), `137`/`139` (NetBIOS), `445` (SMB), `1900` (SSDP) refused before DNS; 22, 53, 80, 443, 8080 stay allowed |
| IPv4 | loopback, private, link-local, `100.64.0.0/10`, `198.18.0.0/15`, multicast, unspecified, `0.0.0.0/8`, `192.0.0.0/24`, `240.0.0.0/4`, broadcast |
| IPv6 | loopback, private, link-local, multicast, unspecified, plus `64:ff9b::/96` and `64:ff9b:1::/48` (NAT64), `2002::/16` (6to4), `2001::/32` (Teredo) |
| Always blocked | cloud metadata (`169.254.169.254`, `169.254.170.2`, `100.100.100.200`, `fd00:ec2::254`, `metadata.google.internal`), reserved ranges, IPv6 transition prefixes, sensitive ports |
| `allowPrivateNetworks` | lifts loopback, private, link-local and shared-use ranges only; metadata, reserved, transition prefixes, unspecified and multicast addresses, and sensitive ports stay blocked |

IPv4-mapped addresses (`::ffff:127.0.0.1`) are checked as IPv4. Every resolved address must pass: one bad record refuses the whole host. The proxy dials the validated IP, never the hostname.

## Web persistence

The token lives in `sessionStorage` under the `lumiboot.proxy.session` key, as `{token, expiresAt, proxyUrl}`. A tab reload keeps it, a tab close drops it. It is purged on expiry, on revocation, if `proxyUrl` differs or if the JSON is invalid, all handled in `apps/web/src/features/proxy/persistence.ts`, and the inherited `localStorage` entry is removed.
