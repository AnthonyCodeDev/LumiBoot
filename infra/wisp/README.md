# Remote WISP relay

Docker Compose WISP relay (`wisp-python` 0.9.0, `Dockerfile:8`) behind Caddy: `wisp` (internal 8080, read-only) and `caddy:2` (80/443), no VM.

## Start

Prerequisites: Linux, Docker Compose, a pointed subdomain, ports 80 and 443 free.

```bash
cp .env.example .env   # WISP_DOMAIN + LUMIBOOT_ORIGIN (exact origin, no trailing slash)
docker compose config
docker compose up -d --build
docker compose logs -f --tail=80
curl -i https://relay.example.com/healthz
```

`/healthz`: Caddy probe, not the WISP backend (`Caddyfile:3`). Caddy returns 403 if `Origin` differs from `LUMIBOOT_ORIGIN` or without a WebSocket upgrade (`Caddyfile:8-18`).

## LumiBoot configuration

`network` section of `apps/web/public/lumiboot.config.json` (template: [`lumiboot.config.network.example.json`](lumiboot.config.network.example.json)):

```json
{
  "version": 1,
  "network": { "defaultProfile": { "mode": "user-relay", "relayUrl": "wss://relay.example.com/" } }
}
```

Add the domain to `connect-src` in `infra/nginx/security-headers.conf`.

## Verification

From the guest: `ip -br addr`, `getent hosts deb.debian.org`, `curl -I https://deb.debian.org/`.

## Limitations

Not a public relay: `Origin` does not authenticate a non-browser client; add authentication, quotas, egress filtering and monitoring before exposing it. Traffic leaves with the server IP. `wisp-python`: AGPL-3.0 ([`../../docs/LICENSES.md`](../../docs/LICENSES.md)).

Stop: `docker compose down`.
