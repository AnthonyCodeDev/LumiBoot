# Images

Only manifests, build scripts and READMEs are versioned; no disk is, and manifests carry no local paths.

| Reference                | OS                                | Arch   | Disk                     | Doc                                                                  |
| ------------------------ | --------------------------------- | ------ | ------------------------ | -------------------------------------------------------------------- |
| `debian-12-i386`         | Debian 12 Bookworm, minimal       | i386   | built locally            | [`debian-12-i386/README.md`](debian-12-i386/README.md)               |
| `debian-12-i386-desktop` | Debian 12 Bookworm, desktop       | i386   | built locally            | [`debian-12-i386/README.md`](debian-12-i386/README.md)               |
| `debian-12-i386-xfce`    | Debian 12 Bookworm, XFCE          | i386   | built locally            | [`debian-12-i386/README.md`](debian-12-i386/README.md)               |
| `ubuntu-18-i386`         | Ubuntu 18.04 LTS bionic, minimal  | i386   | built locally            | [`ubuntu-18-i386/README.md`](ubuntu-18-i386/README.md)               |
| `ubuntu-18-i386-desktop` | Ubuntu 18.04 LTS bionic, desktop  | i386   | built locally            | [`ubuntu-18-i386/README.md`](ubuntu-18-i386/README.md)               |
| `ubuntu-18-i386-xfce`    | Ubuntu 18.04 LTS bionic, XFCE     | i386   | built locally            | [`ubuntu-18-i386/README.md`](ubuntu-18-i386/README.md)               |
| `fedora-44-x86-64`       | Fedora 44, live CLI               | x86_64 | built locally            | [`fedora-44-x86-64/README.md`](fedora-44-x86-64/README.md)           |
| `fedora-44-x86-64-xfce`  | Fedora 44, XFCE                   | x86_64 | built locally            | [`fedora-44-x86-64/README.md`](fedora-44-x86-64/README.md)           |
| `alpine-3-24-x86-64`     | Alpine Linux 3.24, virt ISO (v64) | x86_64 | downloaded by script     | [`alpine-3-24-x86-64/README.md`](alpine-3-24-x86-64/README.md)       |
| `windows-7-x86`          | Windows 7 x86                     | i386   | supplied by the operator | [`windows-7-x86/README.md`](windows-7-x86/README.md)                 |
| `windows-7-pro-sp1-x86`  | Windows 7 Professional SP1 x86    | i386   | supplied by the operator | [`windows-7-pro-sp1-x86/README.md`](windows-7-pro-sp1-x86/README.md) |
| `windows-8-1-x86`        | Windows 8.1 Pro x86               | i386   | supplied by the operator | [`windows-8-1-x86/README.md`](windows-8-1-x86/README.md)             |
| `windows-10-x86`         | Windows 10 x86                    | i386   | supplied by the operator | [`windows-10-x86/README.md`](windows-10-x86/README.md)               |

Windows 7, default reference `windows-7-pro-sp1-x86`: `pnpm assets:windows7:prepare`. Other reference: `-- --ref <ref> --source images/<ref>/disk.img`. Windows 10: `pnpm assets:windows10:prepare`. Windows 8.1 Pro x86: `pnpm assets:windows8:prepare`. Debian: `sudo ./images/debian-12-i386/build.sh`. Ubuntu: `sudo ./images/ubuntu-18-i386/build.sh` (`FLAVOR=desktop|xfce`). Fedora 44: `sudo ./images/fedora-44-x86-64/build.sh` (`FLAVOR=xfce` for `fedora-44-x86-64-xfce`). The three Ubuntu variants are built locally and validated by a real boot (`validated: true`); the Fedora XFCE variant is built locally and published (`validated: true`), and the E2E boot is still to be recorded; no image binary is versioned or distributed. Index and variant order: [`../docs/systems.md`](../docs/systems.md).
