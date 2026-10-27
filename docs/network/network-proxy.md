# Local network proxy

Go binary from `apps/network-proxy`: WISP V1 on `127.0.0.1:37892`, outbound TCP for the guest, no VM launched.

## Flow

1. Frontend: `GET /health` and WISP version.
2. `POST /api/pair/request`.
3. Code approval in the proxy console.
4. Exchange of the approval for a token, then verification.
5. v86 opens `ws://127.0.0.1:37892/wisp/?token=…`.

`/health` proves only that the process responds. `connected` requires a successful `GET /api/session/verify`.

## Running

```bash
cd apps/network-proxy
go run ./cmd/lumiboot-network
```

Options: `--config PATH`, `--listen 127.0.0.1:37892`, `--version`.

Config: `<UserConfigDir>/LumiBoot/Network Proxy/config.json`, absent on first launch, overridden by `LUMIBOOT_PROXY_*`; list in [`../../apps/network-proxy/README.md`](../../apps/network-proxy/README.md).

## Security

- Loopback mandatory unless `allowNonLoopback: true`.
- Exact origin and token bound together.
- Random token hashed with SHA-256, 24 h TTL, 10 min pairing.
- Private networks, loopback, multicast, link-local and cloud metadata blocked after DNS resolution.
- Connection to the validated IP (anti-rebinding).
- 64 global connections, 16 per session.
- No UDP, no inbound listening, no ICMP.

`allowPrivateNetworks` never allows cloud metadata. The token sits in the query string (v86 client limitation): do not log query strings and revoke unused sessions.

## Console

`help`, `list`/`status`, `approve <id|code>`, `deny <id|code>` (alias `refuse`), `revoke <id|all>`, `quit`/`exit`.

## Validation

```bash
cd apps/network-proxy
go test ./...
go vet ./...
gofmt -l .
```

HTTP/WISP contract: [`proxy-contract.md`](proxy-contract.md).
