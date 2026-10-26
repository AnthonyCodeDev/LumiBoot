# Images

Aucun disque n'est versionné : seuls les manifestes (génériques, sans chemin
local), les scripts de build et les README le sont. Les binaires restent dans
`.gitignore` (`*.img`, `*.iso`, `images/*/build*/`).

| Référence | OS | Arch | Disque | Doc |
|---|---|---|---|---|
| `debian-12-i386` | Debian 12 Bookworm (minimal) | i386 | non fourni (build local) | [`debian-12-i386/README.md`](debian-12-i386/README.md) |
| `debian-12-i386-desktop` | Debian 12 Bookworm (bureau) | i386 | non fourni (build local) | [`debian-12-i386/README.md`](debian-12-i386/README.md) |
| `debian-12-i386-xfce` | Debian 12 Bookworm (XFCE) | i386 | non fourni (build local) | [`debian-12-i386/README.md`](debian-12-i386/README.md) |
| `windows-7-x86` | Windows 7 x86 | i386 | non fourni (disque de l'opérateur) | [`windows-7-x86/README.txt`](windows-7-x86/README.txt), [`windows-7.md`](../docs/windows-7.md) |
| `windows-7-pro-sp1-x86` | Windows 7 Professionnel SP1 x86 | i386 | non fourni (disque de l'opérateur) | [`windows-7-pro-sp1-x86/README.txt`](windows-7-pro-sp1-x86/README.txt), [`windows-7.md`](../docs/windows-7.md) |
| `windows-10-x86` | Windows 10 x86 | i386 | non fourni (disque de l'opérateur) | [`windows-10-x86/README.txt`](windows-10-x86/README.txt), [`windows-10.md`](../docs/windows-10.md) |

Préparer un disque Windows : `pnpm assets:windows7:prepare` (Windows 7) ou
`pnpm assets:windows10:prepare` (Windows 10). Construire Debian :
`sudo ./images/debian-12-i386/build.sh`. Détails : [`docs/`](../docs/).
