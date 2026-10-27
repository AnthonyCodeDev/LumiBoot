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

UDP closes with code `0x41`. The proxy advertises `wispVersion: 1`; any other version is refused (`PROXY_WISP_VERSION`).

## Web persistence

The token lives in `sessionStorage` (`lumiboot.proxy.session`: `{token, expiresAt, proxyUrl}`). A tab reload keeps it, a tab close drops it. It is purged on expiry, on revocation, if `proxyUrl` differs or if the JSON is invalid (`apps/web/src/features/proxy/persistence.ts`), and the inherited `localStorage` entry is removed.
