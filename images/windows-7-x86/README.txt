Windows 7 x86 - disk image NOT provided
=======================================
No disk is versioned: disk.img is ignored by Git.

1. Put a RAW disk here: disk.img
2. Regenerate the manifest (Lite variant options):
   pnpm assets:windows7:prepare -- --source images/windows-7-x86/disk.img --ref windows-7-x86 --memory-mib 1024

manifest.json describes size, BIOS boot over HTTP Range and the URL /images/windows-7-x86/disk.img; it stores no absolute path.
