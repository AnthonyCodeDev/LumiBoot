# LumiBoot Network Proxy

Local WISP V1 proxy for v86 VMs: outbound TCP only, no VM. It listens on `127.0.0.1:37892`, from `config.DefaultFor`.

## Build and run

Go 1.22+, as pinned in `go.mod`, from `apps/network-proxy`:

```bash
go test ./...
go vet ./...
go build ./...
go run ./cmd/lumiboot-network
```

Options in `cmd/lumiboot-network`: `--config PATH`, `--listen ADDR`, which must stay loopback, `--version`.

From the repository root, `pnpm proxy:dev` applies the `LUMIBOOT_PROXY_*` values of `.env` and runs `go run ./cmd/lumiboot-network` from this directory, passing its arguments through (`pnpm proxy:dev -- --version`). Without it, export the same variables yourself before running the binary.

## Configuration

Default file: `<UserConfigDir>/LumiBoot/Network Proxy/config.json`, resolved by `platform.ConfigFilePath`. The file is decoded strictly: unknown fields and trailing data are refused (`DisallowUnknownFields`), so a typo such as `allowPrivateNetwork` fails at startup instead of leaving a sensitive permission at its default.

| Field | Default |
|---|---:|
| `listenAddr` | `127.0.0.1:37892` |
| `environment` | `production` |
| `allowedOrigins` | `lumiboot.example.com`, a placeholder you must replace; `development` adds ports 5173/5200/3000/4173/8080 |
| `maxConnections` | `64` |
| `maxConnectionsPerSession` | `16` |
| `connectTimeout` | `10s` |
| `idleTimeout` | `60s` |
| `dataTimeout` | `30s` |
| `initialBufferPackets` | `32` |
| `maxDataChunk` | `131072` |
| `pairingTTL` | `10m` |
| `sessionTokenTTL` | `24h` |

Bounds: `maxConnections` 1..1024, `initialBufferPackets` 1..256, `maxDataChunk` 1..1048576 bytes, 1 MiB maximum; `maxConnectionsPerSession` and the durations must be greater than zero, `bandwidthLimitBytesPerSecond` at least zero. `Config.Validate` refuses an out-of-range value instead of clamping it.

Booleans: `allowLocalOrigins`, `allowPrivateNetworks`, `allowNonLoopback`; `bandwidthLimitBytesPerSecond`, where `0` means unlimited. Defaults live in `config.DefaultFor`.

`LUMIBOOT_PROXY_<FIELD>` overrides, applied by `Config.ApplyEnv`, including `LISTEN_ADDR`, `ENV`, `ALLOWED_ORIGINS`, `BANDWIDTH_LIMIT_BPS`, `PAIRING_TTL`, `SESSION_TOKEN_TTL`. Durations: `10s` or seconds. `ApplyEnv` returns an error when a non-empty variable cannot be parsed, and the `Config.Validate` pass that `Load` runs right after rejects an out-of-range value: an invalid environment fails startup instead of silently falling back to the default.

## Endpoints

Routes are registered in `server.New`.

| Route | Purpose |
|---|---|
| `GET /health` | status, version, `wispVersion`, counters |
| `POST /api/pair/request` | creates a pairing and returns `pairingId` and `userCode` |
| `GET /api/pair/status?id=…` | `pending`, `approved` or `denied` |
| `POST /api/pair/exchange` | exchanges `{pairingId}` for `{token}` |
| `GET /api/session/verify?token=…` | verifies origin and token |
| `POST /api/session/revoke` | revokes a session and closes its streams |
| `GET /wisp/?token=…` | WISP V1 upgrade |

## Pairing

The frontend requests a pairing, the user approves the code in the terminal, and the exchange returns a token bound to the origin. Console commands, listed by `console.printHelp`: `help`, `list`/`status`, `approve`, `deny`, `revoke`, `quit`/`exit`.

The token travels in the query string, read by `server.handleWisp`. It is hashed with SHA-256 through `auth.hashToken`, expirable and revocable.

## Security

- Loopback by default; exact origin and token required.
- Cloud metadata and reserved ranges always blocked; private destinations blocked after DNS, through `security.forbiddenIP` and `security.ValidateDestination`.
- TCP CONNECT only; UDP refused in `wisp.handleConnect`; no inbound port, ICMP not guaranteed.
- No privileges required; Windows, Linux and macOS, amd64/arm64.

Contract: [`../../docs/network/proxy-contract.md`](../../docs/network/proxy-contract.md). Security model: [`../../docs/network/network-proxy.md`](../../docs/network/network-proxy.md).
