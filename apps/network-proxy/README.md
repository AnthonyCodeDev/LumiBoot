# LumiBoot Network Proxy

Local WISP V1 proxy for v86 VMs: outbound TCP only, no VM. Listens on `127.0.0.1:37892` (`internal/config/config.go:141`).

## Build and run

Go 1.22+ (`go.mod:3`), from `apps/network-proxy`:

```bash
go test ./...
go vet ./...
go build ./...
go run ./cmd/lumiboot-network
```

Options (`cmd/lumiboot-network/main.go:32-34`): `--config PATH`, `--listen ADDR`, `--version`.

## Configuration

Default file: `<UserConfigDir>/LumiBoot/Network Proxy/config.json` (`internal/platform/platform.go:13-21`).

| Field | Default |
|---|---:|
| `listenAddr` | `127.0.0.1:37892` |
| `environment` | `production` |
| `allowedOrigins` | `lumiboot.app`; `development` adds ports 5173/5200/3000/4173/8080 |
| `maxConnections` | `64` |
| `maxConnectionsPerSession` | `16` |
| `connectTimeout` | `10s` |
| `idleTimeout` | `60s` |
| `dataTimeout` | `30s` |
| `initialBufferPackets` | `32` |
| `maxDataChunk` | `131072` |
| `pairingTTL` | `10m` |
| `sessionTokenTTL` | `24h` |

Booleans: `allowLocalOrigins`, `allowPrivateNetworks`, `allowNonLoopback`; `bandwidthLimitBytesPerSecond` (`0` = unlimited). Full defaults: `internal/config/config.go:139-158`.

`LUMIBOOT_PROXY_<FIELD>` overrides (`internal/config/config.go:200-254`), including `LISTEN_ADDR`, `ENV`, `ALLOWED_ORIGINS`, `BANDWIDTH_LIMIT_BPS`, `PAIRING_TTL`, `SESSION_TOKEN_TTL`. Durations: `10s` or seconds.

## Endpoints

`internal/server/server.go:76-83`.

| Route | Purpose |
|---|---|
| `GET /health` | status, version, `wispVersion`, counters |
| `POST /api/pair/request` | creates a pairing (`pairingId`, `userCode`) |
| `GET /api/pair/status?id=…` | `pending`, `approved` or `denied` |
| `POST /api/pair/exchange` | exchanges `{pairingId}` for `{token}` |
| `GET /api/session/verify?token=…` | verifies origin and token |
| `POST /api/session/revoke` | revokes a session and closes its streams |
| `GET /wisp/?token=…` | WISP V1 upgrade |

## Pairing

Request from the frontend, approval of the code in the terminal, origin-bound token. Console (`internal/console/console.go:314-319`): `help`, `list`/`status`, `approve`, `deny`, `revoke`, `quit`/`exit`.

The token travels in the query string (`internal/server/server.go:408-426`), is hashed with SHA-256 (`internal/auth/auth.go:565`), expirable and revocable.

## Security

- Loopback by default; exact origin and token required.
- Cloud metadata and reserved ranges always blocked; private destinations blocked after DNS (`internal/security/policy.go:35-51`, `:83-107`).
- TCP CONNECT only, UDP refused (`internal/wisp/handler.go:304`); no inbound port, ICMP not guaranteed.
- No privileges required; Windows, Linux and macOS, amd64/arm64.

Contract: [`../../docs/proxy-contract.md`](../../docs/proxy-contract.md). Security model: [`../../docs/network-proxy.md`](../../docs/network-proxy.md).
