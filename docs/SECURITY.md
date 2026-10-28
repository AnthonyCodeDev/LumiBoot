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
- **CSP**: `connect-src` lists exact origins, never `*` or a scheme-wide rule; set in `infra/nginx/security-headers.conf`.

## Network

- `browser-fetch`: CORS, no raw TCP.
- `user-relay`: WISP relay administered or approved by the user.
- Local proxy: loopback, origin and token verified, private networks and cloud metadata blocked after DNS resolution, quotas and timeouts, all in `apps/network-proxy/internal/security/policy.go`.
- `allowPrivateNetworks` and `allowNonLoopback` weaken isolation; enable them after review.
- The WISP token is visible in the URL: limited lifetime, revocation available.

### DEV / PROD origin allowlist for the network proxy

The allowlist depends on the environment; see `apps/network-proxy/internal/config/config.go`:

- **Production, the default**: `https://lumiboot.example.com`, `https://www.lumiboot.example.com`; no generic `localhost` origin.
- **Development**: `LUMIBOOT_PROXY_ENV=development` adds 5173, 5200, 3000, 4173, 8080 on `127.0.0.1` and `localhost`.
- **Explicit local pairing**: `allowLocalOrigins`, set with `LUMIBOOT_PROXY_ALLOW_LOCAL_ORIGINS=true`, or exact origins. A loopback origin in production without opt-in is refused at validation.

Revocation `POST /api/session/revoke` disconnects: the proxy drops the session and the local storage is purged.

## Deployment

Security headers come from `infra/nginx/security-headers.conf`. COOP/COEP are optional through `LUMIBOOT_COOP_COEP=1`; v86 0.5.471 does not use `SharedArrayBuffer`.

`infra/nginx/site.conf`:

- `/downloads/`: strict static files, no SPA fallback, so a missing file is a real 404; `Accept-Ranges`, compression off to preserve `206`; `/downloads/manifest.json` as `application/json` with `no-store`.
- v86 WASM as `application/wasm`, no fallback under `/v86/`.
- `/images/`: the free Debian disks over HTTP Range, no index and no fallback. Proprietary and user media are forbidden in the webroot: Nginx 404 block on `^/images/.*(windows|winxp|winvista|win[0-9])`, plus `tests/webroot-assets.test.ts` on `apps/web/public/` and `apps/web/dist/`.

## Reporting a vulnerability

Do not open a public issue for an unfixed vulnerability: the tracker indexes and copies it before a patch exists. Use GitHub Security Advisories instead, through the "Security" tab and "Report a vulnerability", or <https://github.com/AnthonyCodeDev/LumiBoot/security/advisories/new>. The report stays private until an advisory is published.

Include the affected version, tag or commit, the platform and browser, and the reproduction steps. Describe the expected and observed impact: what an attacker gains, and which secret or boundary is crossed. Add a suggested fix if you have one.

Acknowledgement is best effort, within 7 days. A fix and a coordinated disclosure date are agreed with you before publication; credit is given unless you ask otherwise. Valid reports cover XSS in the LumiBoot origin and credential leakage through the WISP URL or the pairing bearer. They also cover an origin check bypass in the local proxy and disclosure of a local disk or of guest content.
