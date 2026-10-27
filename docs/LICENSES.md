# Licences and system media

## Rules

- No proprietary disk or ISO committed or distributed.
- Large `.img`, `.iso`, `.qcow`, `.qcow2`, `.vhd`, `.vhdx`, `.vmdk`, `.vdi`, `.ext2/3/4` stay outside Git (`.gitignore`).
- The published manifest holds provenance, size and SHA-256.

## Components

| Component | Licence |
|---|---|
| LumiBoot code | LumiBoot Source-Available License 1.0 (source-available, not OSI open source; see [`LICENSE`](../LICENSE)) |
| v86 0.5.471 | BSD-2-Clause |
| React, Vite, Zod, Zustand | MIT |
| gorilla/websocket | BSD-2-Clause |
| wisp-python 0.9.0 (`infra/wisp`) | AGPL-3.0 |

The LumiBoot Source-Available License 1.0 keeps the source public and allows personal, educational and evaluation use with attribution; all commercial rights, relicensing and sublicensing are reserved to the author.

`infra/wisp` embeds wisp-python 0.9.0 under AGPL-3.0. A modified redistribution of that component stays governed by AGPL-3.0; the root licence does not replace it and the AGPL-3.0 notice must be kept.

## Systems

- Debian: Bookworm images, provenance and packages recorded (`packages.tsv`).
- Windows 7: operator RAW disks, outside Git, HTTP Range in development; no image or key distributed.
- Windows 10 (32-bit): operator RAW disk converted from their own QEMU/VirtualBox installation, outside Git, HTTP Range in development. The user's Windows licence is required; no media or third-party link distributed. Same pipeline as Windows 7: [`images/windows-10-x86/README.md`](../images/windows-10-x86/README.md).
- Windows 11 (64-bit): user media required, no integrated x86-64 engine.
- macOS: Apple licence and authorised hardware.

Icons: SVG in `apps/web/public/icons/os/`.
