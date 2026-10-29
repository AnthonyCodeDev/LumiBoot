# Remote WISP relay

Docker Compose WISP relay built on `wisp-python` 0.9.0, pinned in the `Dockerfile` `pip install` step, behind Caddy: `wisp`, internal only, with compose `expose: 8080` and read-only, and `caddy:2` publishing 80 and 443 on **loopback only** by default. No VM.

## Start

Prerequisites: Linux, Docker Compose, a pointed subdomain, ports 80 and 443 free.

```bash
cp .env.example .env   # WISP_DOMAIN + LUMIBOOT_ORIGIN, exact origin without a trailing slash
docker compose config
docker compose up -d --build
docker compose logs -f --tail=80
curl -i https://relay.example.com/healthz
```

By default `WISP_BIND_ADDRESS` is `127.0.0.1`: Caddy listens on `127.0.0.1:80` and `127.0.0.1:443`, reachable only through a front end on the same host (another reverse proxy, an SSH tunnel, or a private network). Nothing is published on the server's external interface.

### Exposing the relay publicly

Exposure is opt-in and explicit:

```bash
WISP_BIND_ADDRESS=0.0.0.0 docker compose up -d
```

> **Warning** — a public relay is an open TCP proxy into the server's network and into the internet from the server's IP. The only built-in check is the `Origin` header, which a non-browser client forges in one line. Expose it only when **all** of the following hold:
>
> - authentication happens at the border (mTLS, an authenticating reverse proxy, or a private network/VPN), not in this compose stack;
> - egress is filtered from the relay container (block RFC 1918, loopback, link-local, cloud metadata `169.254.169.254`, and any host-local service);
> - quotas, logs and monitoring are in place.
>
> If you cannot provide them, keep the default loopback binding and do not expose it.

`/healthz` is a Caddy probe, not the WISP backend: it comes from the `handle /healthz` block of the `Caddyfile`. Caddy returns 403 if `Origin` differs from `LUMIBOOT_ORIGIN` or without a WebSocket upgrade: the `handle @allowed` block only reverse-proxies to `wisp:8080` when both headers match, and the fallback `handle` responds 403.

## Container hardening

Both services drop every capability; `caddy` adds back `NET_BIND_SERVICE` only, to bind 80/443. Both run with `no-new-privileges`, a read-only root filesystem, a 16 MiB `/tmp` tmpfs, `pids_limit: 128` and `mem_limit: 256m`. `caddy` keeps `/data` (certificates) and `/config` (autosaved JSON) as named volumes, so they stay writable despite the read-only root.

## LumiBoot configuration

`network` section of `apps/web/public/lumiboot.config.json`; a template is provided in [`lumiboot.config.network.example.json`](lumiboot.config.network.example.json):

```json
{
  "version": 1,
  "network": { "defaultProfile": { "mode": "user-relay", "relayUrl": "wss://relay.example.com/" }, "systems": {} }
}
```

`wss:` is already allowed scheme-wide in `connect-src` for `user-relay`; to tighten it, list the exact relay origin (for example `wss://relay.example.com`) in `infra/nginx/security-headers.conf`.

## Verification

From the guest: `ip -br addr`, `getent hosts deb.debian.org`, `curl -I https://deb.debian.org/`.

## Limitations

The binding is loopback-only by default and the stack ships no authentication: `Origin` does not authenticate a non-browser client, so a public relay needs authentication at the border, quotas, egress filtering and monitoring (`WISP_BIND_ADDRESS=0.0.0.0` is an explicit opt-in, see above). Traffic leaves with the server IP. `wisp-python` is under AGPL-3.0; see [`../../docs/LICENSES.md`](../../docs/LICENSES.md).

Stop: `docker compose down`.
