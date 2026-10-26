# Licences and system media

## Rules

- No proprietary disk or ISO committed or distributed.
- Large `.img`, `.iso`, `.qcow`, `.qcow2`, `.vhd`, `.vhdx`, `.vmdk`, `.vdi`, `.ext2/3/4` outside Git (`.gitignore`).
- Published manifest: provenance, size, SHA-256.

## Components

| Component | Licence |
|---|---|
| LumiBoot code | no declared licence (no `LICENSE`) |
| v86 0.5.471 | BSD-2-Clause |
| React, Vite, Zod, Zustand | MIT |
| gorilla/websocket | BSD-2-Clause |
| wisp-python 0.9.0 (`infra/wisp`) | AGPL-3.0 |

## Systems

- Debian: Bookworm images, provenance and packages recorded (`packages.tsv`).
- Windows 7: operator's local RAW disks, outside Git, HTTP Range in development; no image or key distributed.
- Windows 10 (32-bit): operator's RAW disk (converted from their own QEMU/VirtualBox installation), outside Git, HTTP Range in development; the user's Windows licence is required, no media or third-party link distributed. Same pipeline as Windows 7: [`windows-10.md`](windows-10.md).
- Windows 11 (64-bit): user media required, no integrated x86-64 engine.
- macOS: Apple licence and authorised hardware.

Icons: SVG in `apps/web/public/icons/os/`.
