# LumiBoot Network Proxy

Local WISP V1 proxy for v86 VMs: outbound TCP only, no VM. It listens on `127.0.0.1:37892` (`config.DefaultFor`).

## Build and run

Go 1.22+ (`go.mod`), from `apps/network-proxy`:

```bash
go test ./...
go vet ./...
go build ./...
go run ./cmd/lumiboot-network
```

Options in `cmd/lumiboot-network`: `--config PATH`, `--listen ADDR` (must stay loopback), `--version`.

## Configuration

Default file: `<UserConfigDir>/LumiBoot/Network Proxy/config.json` (`platform.ConfigFilePath`).

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

Booleans: `allowLocalOrigins`, `allowPrivateNetworks`, `allowNonLoopback`; `bandwidthLimitBytesPerSecond` (`0` = unlimited). Defaults live in `config.DefaultFor`.

`LUMIBOOT_PROXY_<FIELD>` overrides (`Config.ApplyEnv`), including `LISTEN_ADDR`, `ENV`, `ALLOWED_ORIGINS`, `BANDWIDTH_LIMIT_BPS`, `PAIRING_TTL`, `SESSION_TOKEN_TTL`. Durations: `10s` or seconds.

## Endpoints

Routes are registered in `server.New`.

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

The frontend requests a pairing, the user approves the code in the terminal, and the exchange returns a token bound to the origin. Console commands (`console.printHelp`): `help`, `list`/`status`, `approve`, `deny`, `revoke`, `quit`/`exit`.

The token travels in the query string (`server.handleWisp`). It is hashed with SHA-256 (`auth.hashToken`), expirable and revocable.

## Security

- Loopback by default; exact origin and token required.
- Cloud metadata and reserved ranges always blocked; private destinations blocked after DNS (`security.forbiddenIP`, `security.ValidateDestination`).
- TCP CONNECT only; UDP refused in `wisp.handleConnect`; no inbound port, ICMP not guaranteed.
- No privileges required; Windows, Linux and macOS, amd64/arm64.

Contract: [`../../docs/network/proxy-contract.md`](../../docs/network/proxy-contract.md). Security model: [`../../docs/network/network-proxy.md`](../../docs/network/network-proxy.md).
