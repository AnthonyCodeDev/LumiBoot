# Local network proxy contract

Base: `http://127.0.0.1:37892`. JSON responses, except the WebSocket upgrade; sensitive routes require an allowed origin.

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

Errors: `400` invalid JSON (unknown fields refused); `403` origin refused or exchange impossible; `401` invalid token on `verify`, `403` on `/wisp/`; `404` unknown or expired pairing/session; `429` too many requests (64 pending, 8 per origin).

## Pairing

- Request valid for 10 minutes by default.
- Exchange: same origin and console approval; single-use pairing id.
- Token: 32 random bytes base64url, returned once, stored hashed, bound to the origin, 24 hours by default.

`connected` is only shown after a successful `GET /api/session/verify`; a valid `/health` leaves `pairing-required`.

## WISP V1

Frame: `[type:u8][stream_id:u32 little-endian][payload]`. The CONNECT payload is `[stream_type:u8][port:u16 LE][hostname UTF-8]`.

| Type | Code | Support |
|---|---:|---|
| CONNECT | `0x01` | TCP only |
| DATA | `0x02` | yes |
| CONTINUE | `0x03` | yes; initial window announced at handshake |
| CLOSE | `0x04` | yes |
| INFO V2 | `0x05` | ignored |

UDP is closed with code `0x41`. The proxy advertises `wispVersion: 1`; any other version is refused (`PROXY_WISP_VERSION`).

## Web persistence

Token in `sessionStorage` (`lumiboot.proxy.session`: `{token, expiresAt, proxyUrl}`): survives a tab reload, not a tab close; purged on expiry, on revocation, if `proxyUrl` differs or if the JSON is invalid (`apps/web/src/features/proxy/persistence.ts`), the inherited `localStorage` entry being removed.
