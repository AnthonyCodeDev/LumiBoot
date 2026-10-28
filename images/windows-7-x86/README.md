# Windows 7 Lite x86

`windows-7-x86`, the Lite variant of the Windows 7 family: 16 GiB RAW disk, 1024 MiB of guest RAM, BIOS boot, `disk-boot` readiness. Parent of the group, not the default.

## What you must provide

An installed 32-bit Windows 7 RAW disk, bootable in BIOS/MBR, and your own licence; a UEFI/GPT disk does not boot. No disk, ISO or key is shipped: `disk.img` is Git-ignored, `manifest.json` stores no absolute path.

1. Put the RAW disk here: `disk.img`.
2. Regenerate the manifest with the Lite options:

```bash
pnpm assets:windows7:prepare -- --source images/windows-7-x86/disk.img --ref windows-7-x86 --memory-mib 1024
```

`manifest.json` then describes size, BIOS boot over HTTP Range and the URL `/images/windows-7-x86/disk.img`.

For the full pipeline — NE2000 driver installed offline, readiness proof, HTTP Range server, limitations — see [`windows-7-pro-sp1-x86/README.md`](../windows-7-pro-sp1-x86/README.md).
