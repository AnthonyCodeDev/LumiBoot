Windows 10 x86 - disk image NOT provided
========================================
No disk is versioned: disk.img is ignored by Git.

1. Put a RAW disk here: disk.img
2. Regenerate the manifest: pnpm assets:windows10:prepare

manifest.json describes size, BIOS boot over HTTP Range and the URL /images/windows-10-x86/disk.img; it stores no absolute path.
