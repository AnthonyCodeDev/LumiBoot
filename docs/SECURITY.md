# Security

## Invariants

- VMs run in the browser; no server-side boot.
- `VITE_*` and `apps/web/public/lumiboot.config.json` are public: no secrets.
- Proprietary media and large disks stay outside Git and outside the Vite bundle.
- `ready`, `running` and `connected` require technical proof.
- No log, error report or telemetry captures the terminal or guest content.

## XSS threat

Guest and network data are untrusted. An XSS reads every secret in the JS context of the LumiBoot origin.

- **Pairing bearer**: `sessionStorage` only (`lumiboot.proxy.session`), scoped to the tab and lost on close. The legacy `localStorage` key is purged without migration. Execution never reads storage: the in-memory copy lives in `getProxyRuntimeCredentials`, inside the authenticated state in `apps/web/src/features/proxy/persistence.ts`.
- **WISP URL**: token in the query string (`…/wisp/?token=…`), a v86 0.5.471 limitation. WISP URLs and tokens never reach `console.*` or an error report; `tests/security-config.test.ts` fails on `token`, `wisp`, `relay_url` or `proxyToken` in a frontend log.
- **Sourcemaps**: disabled in production. Opt-in with `LUMIBOOT_SOURCEMAP=1`, or `hidden`, which keeps the `.map` unpublished.
- **CSP**: `connect-src` never uses `*`; it lists the loopback proxy origins explicitly (`127.0.0.1`, `localhost` and `[::1]` on 37892, HTTP(S) and WS(S)), and the only scheme-wide entry is `wss:`, required by `user-relay` where the relay host is supplied by the user and cannot be enumerated. The compromise is deliberate: a compromised page could still open a TLS WebSocket to any host, but plain `ws:`, `http:` and non-network schemes stay out. The origins are rendered from `LUMIBOOT_PROXY_PORT` by `pnpm config:nginx` into `infra/nginx/security-headers.conf`; they stay explicit for every port, never `*`.

## Network

- `browser-fetch`: CORS, no raw TCP.
- `user-relay`: WISP relay administered or approved by the user.
- Local proxy: loopback, origin and token verified, private networks and cloud metadata blocked after DNS resolution in `apps/network-proxy/internal/security/policy.go`, which every CONNECT passes before the dial; quotas and timeouts are enforced around it. IPv6 transition prefixes (NAT64 `64:ff9b::/96`, local-use NAT64 `64:ff9b:1::/48`, 6to4 `2002::/16`, Teredo `2001::/32`) and IETF assignments (`192.0.0.0/24`) are blocked unconditionally, because they can carry an IPv4 destination (behind NAT64, `64:ff9b::7f00:1` routes to `127.0.0.1`). Ports 25, 137, 139, 445 and 1900 are refused before the dial.
- The browser `Origin` header is mandatory and authoritative on sensitive routes: `POST /api/pair/request` answers `400` without it, and no route reads an origin from the body.
- HTTP timeouts bound header read (10 s), request read (15 s), response write (30 s) and keep-alive idle (120 s); after the WISP upgrade, a read deadline of `idleTimeout` (60 s by default) and a 10 s write deadline close a silent or stuck peer.
- A session token holds at most four simultaneous WebSocket transports (`MaxTransportsPerToken`); a fifth is refused with `429`, so one token cannot fan out connections.
- Every proxy JSON response sets `Cache-Control: no-store` and `Pragma: no-cache`: pairing codes, tokens and expiry dates never enter a browser or intermediary cache.
- `allowPrivateNetworks` and `allowNonLoopback` weaken isolation; enable them after review, and read the startup banner, which prints the effective values: `allowNonLoopback` also means the pairing token travels in clear text on the LAN unless TLS terminates in front of the proxy.
- The remote WISP relay in `infra/wisp/` publishes 80/443 on `127.0.0.1` by default: `WISP_BIND_ADDRESS=0.0.0.0` is the explicit opt-in, and a public relay needs authentication at the border plus egress filtering, since `Origin` authenticates nothing.
- The WISP token is visible in the URL: limited lifetime, revocation available.

### DEV / PROD origin allowlist for the network proxy

The allowlist depends on the environment; see `apps/network-proxy/internal/config/config.go`:

- **Production, the default**: `https://lumiboot.example.com`, `https://www.lumiboot.example.com`; no generic `localhost` origin.
- **Development**: `LUMIBOOT_PROXY_ENV=development` adds 5173, 5200, 3000, 4173, 8080 on `127.0.0.1` and `localhost`.
- **Explicit local pairing**: `allowLocalOrigins`, set with `LUMIBOOT_PROXY_ALLOW_LOCAL_ORIGINS=true`, or exact origins. A loopback origin in production without opt-in is refused at validation.

Revocation `POST /api/session/revoke` disconnects: the proxy drops the session and the local storage is purged.

## Deployment

Security headers come from `infra/nginx/security-headers.conf`, rendered from `infra/nginx/security-headers.conf.template` by `pnpm config:nginx`. The CSP `connect-src` origins follow `LUMIBOOT_PROXY_PORT` (default 37892) and stay explicit, never `*`; `pnpm config:nginx:check` fails when the tracked file drifted from its template. The Vite dev and preview servers enable COOP/COEP by default because v64 uses `SharedArrayBuffer` for parallel vCPU Workers; `LUMIBOOT_COOP_COEP=0` selects the cooperative fallback. v86 0.5.471 itself does not use `SharedArrayBuffer`.

The development disk middleware serves operator-owned RAW images from `images/` only to the loopback host and the same browser origin. It rejects a foreign `Host` or `Origin`, omits CORS permission and sends `Cross-Origin-Resource-Policy: same-origin`. `infra/dev/docker-compose.yml` publishes the development server on loopback only. The separate local asset server requires a token whenever `--expose` selects a non-loopback host; `--no-token` also disables cross-origin browser access.

The Ubuntu image builder requires a trusted archive keyring by default. `LUMIBOOT_ALLOW_UNVERIFIED_ARCHIVE=1` is an explicit escape hatch for disposable local builds. The Debian and Ubuntu builders refuse to erase a populated custom `LUMIBOOT_BUILD_DIR` unless it has their `.lumiboot-build` marker.

`infra/nginx/site.conf`:

- `/downloads/`: strict static files, no SPA fallback, so a missing file is a real 404; `Accept-Ranges`, compression off to preserve `206`; `/downloads/manifest.json` as `application/json` with `no-store`.
- v86 WASM as `application/wasm`, no fallback under `/v86/`.
- `/images/`: the free Debian and Ubuntu disks over HTTP Range, no index and no fallback. Proprietary and user media are forbidden in the webroot: Nginx 404 block on `^/images/.*(windows|winxp|winvista|win[0-9])`, plus `tests/webroot-assets.test.ts` on `apps/web/public/` and `apps/web/dist/`, whose allowlist accepts only the `/^debian-/i` and `/^ubuntu-/i` disk refs.

## Known dependency advisories

`react-router@6.30.6`, pulled in by `react-router-dom@^6.27.0` in `apps/web`, carries two moderate advisories: an open redirect through a backslash in a crafted path, and deserialization of attacker-controlled error data under SSR. Neither is known to be exploitable here: LumiBoot is a client-only SPA with no server-side rendering or hydration, and no user-controlled value reaches a router redirect or a programmatic navigation. The durable fix is the major migration to `react-router` 7.18+, which drops the 6.x advisory surface entirely.

## Reporting a vulnerability

Do not open a public issue for an unfixed vulnerability: the tracker indexes and copies it before a patch exists. Use GitHub Security Advisories instead, through the "Security" tab and "Report a vulnerability", or <https://github.com/AnthonyCodeDev/LumiBoot/security/advisories/new>. The report stays private until an advisory is published.

Include the affected version, tag or commit, the platform and browser, and the reproduction steps. Describe the expected and observed impact: what an attacker gains, and which secret or boundary is crossed. Add a suggested fix if you have one.

Acknowledgement is best effort, within 7 days. A fix and a coordinated disclosure date are agreed with you before publication; credit is given unless you ask otherwise. Valid reports cover XSS in the LumiBoot origin and credential leakage through the WISP URL or the pairing bearer. They also cover an origin check bypass in the local proxy and disclosure of a local disk or of guest content.
