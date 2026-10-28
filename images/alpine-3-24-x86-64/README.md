# Alpine Linux 3.24 x86-64 for v64

`pnpm assets:v64:alpine` downloads the official unmodified Alpine 3.24.0
`virt` ISO, verifies the SHA-256 used by v64's own x86-64 tests, extracts its
kernel and initramfs, and publishes the three files plus a checked manifest in
`apps/web/public/images/alpine-3-24-x86-64/`.

The ISO and extracted binaries are build assets and are not committed. The
guest boots entirely in the browser. `localhost login:` on COM1 is the boot
proof; a JavaScript timer is never treated as a successful boot.

Runtime revision: `speedyHKjournalist/v64@74d2bafcc7d568e2ab4374804e176f1a8a350f61`.
