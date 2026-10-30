# Licences and system media

## Rules

- No proprietary disk or ISO committed or distributed.
- Large `.img`, `.iso`, `.qcow`, `.qcow2`, `.vhd`, `.vhdx`, `.vmdk`, `.vdi`, `.ext2/3/4` stay outside Git, ignored in `.gitignore`.
- The published manifest holds provenance, size and SHA-256.

## Components

| Component | Licence |
|---|---|
| LumiBoot code | LumiBoot Source-Available License 1.0; source-available, not OSI open source, see [`LICENSE`](../LICENSE) |
| v86 0.5.471 | BSD-2-Clause |
| SeaBIOS (`seabios.bin`) | LGPL-3.0 |
| VGABIOS (`vgabios.bin`) | LGPL or GPL, depending on the upstream build |
| React, Vite, Zod, Zustand | MIT |
| react-router-dom | MIT |
| Inter (`apps/web/public/fonts/`) | SIL OFL 1.1 |
| gorilla/websocket | BSD-2-Clause |
| wisp-python 0.9.0 (`infra/wisp`) | AGPL-3.0 |
| `caddy:2` image (`infra/wisp`) | Apache-2.0 |
| `python:3.12-slim` image (`infra/wisp`) | PSF-2.0 |
| `node:22-bookworm` image (`infra/dev`) | MIT |
| nginx deployment (`infra/nginx`) | BSD-2-Clause |

The LumiBoot Source-Available License 1.0 keeps the source public and allows personal, educational and evaluation use with attribution; all commercial rights, relicensing and sublicensing are reserved to the author.

`infra/wisp` embeds wisp-python 0.9.0 under AGPL-3.0. A modified redistribution of that component stays governed by AGPL-3.0; the root licence does not replace it and the AGPL-3.0 notice must be kept.

`seabios.bin` (131072 B) and `vgabios.bin` (36352 B) are fetched from `copy/v86` at commit
`94faf3d`. Size and SHA-256 are pinned in
[`scripts/v86-assets.lock.json`](../scripts/v86-assets.lock.json).

TypeScript, ESLint, Prettier, Vitest, Playwright and Testing Library are development
dependencies under MIT or Apache-2.0. They are not shipped in the bundle.

The typeface is self-hosted from `apps/web/public/fonts/`. No font, stylesheet, script or
image is loaded from an external domain at runtime.

## Systems

- Debian: Bookworm images, provenance and packages recorded (`packages.tsv`).
- Ubuntu 18.04 LTS: locally built bionic images, provenance and packages recorded (`packages.tsv`); no image distributed.
- Windows 7: operator RAW disks, outside Git, HTTP Range in development; no image or key distributed.
- Windows 8.1 Pro x86: operator RAW disk converted from their own QEMU/VirtualBox installation, outside Git, HTTP Range in development. The user's Windows licence is required; no media or third-party link distributed. Same pipeline as Windows 7: [`images/windows-8-1-x86/README.md`](../images/windows-8-1-x86/README.md).
- Windows 10 x86: operator RAW disk converted from their own QEMU/VirtualBox installation, outside Git, HTTP Range in development. The user's Windows licence is required; no media or third-party link distributed. Same pipeline as Windows 7: [`images/windows-10-x86/README.md`](../images/windows-10-x86/README.md).
- Windows 11: not developed; no x86-64 engine, no image, no media distributed.
- Custom image: any `.iso`, `.img` or `.raw` imported by the visitor, kept as a local blob in the tab; LumiBoot distributes no media and the file is never uploaded.
- macOS: Apple licence and authorised hardware.

## Trademarks

- The OS icons in `apps/web/public/icons/os/` are the official brand marks, sourced from [Simple Icons](https://simpleicons.org/) (released under CC0 1.0). Brand colours follow each owner's palette. See https://simpleicons.org/ for the full set.
- Windows, macOS, Ubuntu, Fedora and Debian are trademarks of their respective owners.
- LumiBoot is not affiliated with, endorsed by or sponsored by any of them.
- Those names and icons are used only to identify the systems, nominatively and descriptively.
