# Security

## Invariants

- VMs run in the browser; no server-side boot.
- `VITE_*` and `apps/web/public/lumiboot.config.json` are public: no secrets.
- Proprietary media and large disks outside Git and outside the Vite bundle.
- `ready`, `running`, `connected` require technical proof.
- No log, error report or telemetry captures the terminal or guest content.

## XSS threat

Untrusted data (guest, network); an XSS reads every secret in the JS context of the LumiBoot origin.

- **Pairing bearer**: `sessionStorage` only (`lumiboot.proxy.session`), scoped to the tab, lost on close. Legacy `localStorage` key purged without migration. Execution never reads storage: in-memory copy only (`getProxyRuntimeCredentials`), in the authenticated state (`apps/web/src/features/proxy/persistence.ts`).
- **WISP URL**: token in the query string (`…/wisp/?token=…`), v86 0.5.471 limitation. No logging of WISP URLs or tokens (`console.*`, error reports); `tests/security-config.test.ts` fails on `token`, `wisp`, `relay_url`, `proxyToken` in a frontend log.
- **Sourcemaps**: disabled in production; a public `.map` exposes the source. Opt-in `LUMIBOOT_SOURCEMAP=1`, or `hidden` (`.map` not published).
- **CSP**: `connect-src` as an allow-list of exact origins, never `*` or a scheme-wide rule (`infra/nginx/security-headers.conf`).

## Network

- `browser-fetch`: CORS, no raw TCP.
- `user-relay`: WISP relay administered or approved by the user.
- Local proxy: loopback, origin + token verified, private networks and cloud metadata blocked after DNS resolution, quotas and timeouts (`apps/network-proxy/internal/security/policy.go`).
- `allowPrivateNetworks`, `allowNonLoopback`: weaken isolation, enable after review.
- WISP token visible in the URL: limited lifetime, revocation available.

### DEV / PROD origin allowlist (network proxy)

Split per environment (`apps/network-proxy/internal/config/config.go`):

- **Production (default)**: `https://lumiboot.app`, `https://www.lumiboot.app`; no generic `localhost` origin.
- **Development**: `LUMIBOOT_PROXY_ENV=development` adds 5173, 5200, 3000, 4173, 8080 on `127.0.0.1` and `localhost`. Dev machine only.
- **Explicit local pairing**: `allowLocalOrigins` (`LUMIBOOT_PROXY_ALLOW_LOCAL_ORIGINS=true`) or exact origins. A loopback origin in production without opt-in is refused at validation.

Revocation `POST /api/session/revoke` = disconnect: session removed on the proxy side, local storage purged.

## Deployment

`infra/nginx/security-headers.conf`. Optional COOP/COEP via `LUMIBOOT_COOP_COEP=1`; v86 0.5.471 does not use `SharedArrayBuffer`.

`infra/nginx/site.conf`:

- `/downloads/`: strict static files, no SPA fallback (real 404); `Accept-Ranges`, compression off to preserve `206`; `/downloads/manifest.json` as `application/json` (`no-store`).
- v86 WASM as `application/wasm`, no fallback under `/v86/`.
- `/images/`: free disks (Debian) over HTTP Range, no index and no fallback; proprietary and user media forbidden in the webroot: Nginx 404 block (`^/images/.*(windows|winxp|winvista|win[0-9])`) + `tests/webroot-assets.test.ts` on `apps/web/public/` and `apps/web/dist/`.

## Source export / release bundle

- **Source** (`python export_project_zip.py`): oversized artifact **omitted** (never a fake `.img`/`.exe`), described in `EXPORT-MANIFEST.json` (path, size, SHA-256); `images/` untouched.
- **Release** (`--profile release`): `apps/web/dist` + `apps/web/public/downloads` only, non-free media refused.

Report vulnerabilities privately to the maintainers.
