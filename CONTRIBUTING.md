# Contributing to LumiBoot

React/TypeScript UI, Go network proxy. Keep changes small, focused and verifiable.

## Requirements

- Node >= 20, pnpm 9.14.2 (`corepack enable`), Go stable 1.22+ for `apps/network-proxy`, recent Chrome, Edge or Firefox.

## Setup

```bash
pnpm install
pnpm assets:prepare
pnpm dev
```

Dev server: port defined by `WEB_DEV_PORT` (default `5173`), strict, configured through the root `.env` copied from `.env.example`. Windows 7/10 disks are not in Git; the app asks for a local RAW disk. Debian and Ubuntu images need Linux or WSL2; the boot test is opt-in through `VM_E2E_ASSETS=1`.

## Checks before opening a pull request

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm test:e2e   # Playwright, port 5200
```

`pnpm test:e2e` starts its own server on port 5200; never point it at 5173. `pnpm format` fixes formatting.

## Conventions

- TypeScript strict; no `any` left behind to silence the compiler.
- Justify new dependencies in the pull request: size, maintenance, licence.
- Tests sit next to the code as `*.test.ts(x)`; cross-cutting guards go in `tests/`; comment intent, not the code.
- No secrets, tokens, licence keys, personal data, VM binaries, disks or proprietary media in Git.

## Pull request process

1. One concern per pull request; split unrelated fixes and explain *why* in the description. Add a
   screenshot or short recording for any UI change; wait for green CI before review.

## Licensing of contributions

By submitting a contribution you agree that it is licensed under the LumiBoot Source-Available
License 1.0, see [`LICENSE`](LICENSE), and that the author may integrate it under the same terms,
including commercially, while you keep your copyright. Re-publication under another name and
commercial use still require the author's permission.

## Never commit

- Disk or ISO images: `.img`, `.iso`, `.qcow2`, `.vhd`, `.vmdk`, `.vdi`, `.ext*`; `apps/web/public/images/`, `apps/web/public/v86/`.
- Release binaries of `apps/web/public/downloads/`: `*.exe`, `*.tar.gz` and `*.zip`; publish as
  GitHub Release assets, keep only `manifest.json` and `SHA256SUMS`.
- Playwright reports and traces: `playwright-report/` and `test-results/`; caches, build output and
  logs: `node_modules/`, `dist/`, `*.log`, `.env*`.
