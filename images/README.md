# Images

No disk is versioned: only manifests (without local paths), build scripts and READMEs are.

| Reference | OS | Arch | Disk | Doc |
|---|---|---|---|---|
| `debian-12-i386` | Debian 12 Bookworm (minimal) | i386 | not provided (local build) | [`debian-12-i386/README.md`](debian-12-i386/README.md) |
| `debian-12-i386-desktop` | Debian 12 Bookworm (desktop) | i386 | not provided (local build) | [`debian-12-i386/README.md`](debian-12-i386/README.md) |
| `debian-12-i386-xfce` | Debian 12 Bookworm (XFCE) | i386 | not provided (local build) | [`debian-12-i386/README.md`](debian-12-i386/README.md) |
| `windows-7-x86` | Windows 7 x86 | i386 | not provided (operator disk) | [`windows-7-x86/README.txt`](windows-7-x86/README.txt), [`windows-7.md`](../docs/windows-7.md) |
| `windows-7-pro-sp1-x86` | Windows 7 Professional SP1 x86 | i386 | not provided (operator disk) | [`windows-7-pro-sp1-x86/README.txt`](windows-7-pro-sp1-x86/README.txt), [`windows-7.md`](../docs/windows-7.md) |
| `windows-10-x86` | Windows 10 x86 | i386 | not provided (operator disk) | [`windows-10-x86/README.txt`](windows-10-x86/README.txt), [`windows-10.md`](../docs/windows-10.md) |

Windows 7 (`windows-7-pro-sp1-x86` by default): `pnpm assets:windows7:prepare`; other reference: `-- --ref <ref> --source images/<ref>/disk.img`. Windows 10: `pnpm assets:windows10:prepare`. Debian: `sudo ./images/debian-12-i386/build.sh`. Details: [`../docs/`](../docs/).
