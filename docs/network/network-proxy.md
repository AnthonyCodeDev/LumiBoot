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
- Exact origin and token bound together; the `Origin` header is mandatory, including on `POST /api/pair/request`, which answers `400` without it: the origin is never read from the body.
- Random token hashed with SHA-256, 24 h TTL, 10 min pairing.
- Private networks, loopback, multicast, link-local and cloud metadata blocked after DNS resolution; IPv6 transition prefixes (NAT64, 6to4, Teredo) and `192.0.0.0/24` are refused unconditionally, and IPv4-mapped addresses are checked as IPv4.
- Ports 25, 137, 139, 445 and 1900 refused before DNS.
- Connection to the validated IP, which defeats rebinding.
- 64 global connections, 16 per session; 4 WebSocket transports per token.
- No UDP, no inbound listening, no ICMP.

`allowPrivateNetworks` lifts loopback, private, link-local and shared-use ranges only: cloud metadata, reserved ranges, transition prefixes, unspecified and multicast addresses, and sensitive ports stay blocked. The v86 client forces the token into the query string: do not log query strings and revoke unused sessions.

## Console

`help`, `list`/`status`, `approve <id|code>`, `deny <id|code>` with `refuse` as an alias, `revoke <id|all>`, `quit`/`exit`.

## Validation

```bash
cd apps/network-proxy
go test ./...
go vet ./...
gofmt -l .
```

HTTP/WISP contract: [`proxy-contract.md`](proxy-contract.md).
