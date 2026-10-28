# Images

Only manifests, build scripts and READMEs are versioned; no disk is, and manifests carry no local paths.

| Reference | OS | Arch | Disk | Doc |
|---|---|---|---|---|
| `debian-12-i386` | Debian 12 Bookworm, minimal | i386 | built locally | [`debian-12-i386/README.md`](debian-12-i386/README.md) |
| `debian-12-i386-desktop` | Debian 12 Bookworm, desktop | i386 | built locally | [`debian-12-i386/README.md`](debian-12-i386/README.md) |
| `debian-12-i386-xfce` | Debian 12 Bookworm, XFCE | i386 | built locally | [`debian-12-i386/README.md`](debian-12-i386/README.md) |
| `windows-7-x86` | Windows 7 x86 | i386 | supplied by the operator | [`windows-7-x86/README.md`](windows-7-x86/README.md) |
| `windows-7-pro-sp1-x86` | Windows 7 Professional SP1 x86 | i386 | supplied by the operator | [`windows-7-pro-sp1-x86/README.md`](windows-7-pro-sp1-x86/README.md) |
| `windows-10-x86` | Windows 10 x86 | i386 | supplied by the operator | [`windows-10-x86/README.md`](windows-10-x86/README.md) |

Windows 7, default reference `windows-7-pro-sp1-x86`: `pnpm assets:windows7:prepare`. Other reference: `-- --ref <ref> --source images/<ref>/disk.img`. Windows 10: `pnpm assets:windows10:prepare`. Debian: `sudo ./images/debian-12-i386/build.sh`. Index and variant order: [`../docs/systems.md`](../docs/systems.md).
