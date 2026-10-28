# Network client downloads

This folder holds the public manifest of the LumiBoot Network client,
`manifest.json`, and its checksums, `SHA256SUMS`. The binaries are **not
tracked by Git**: they are published as assets of the GitHub Releases of this
repository, through the `network-proxy.yml` workflow and the `network-v*` tag.
Every `*.exe`, `*.tar.gz`, `*.zip`, `*.msi` and `*.pkg` file here is ignored.

## Local development

The web app serves `/downloads/...` from this folder, so the files must exist
on disk for the download links to work: download the
`LumiBoot-Network-proxy-<version>.zip` asset from the latest GitHub Release and
extract it here, or run the `network-proxy.yml` workflow and use its artifacts.

## Integrity and signatures

`SHA256SUMS` lists the SHA-256 digest of every archive in `manifest.json`;
verify a download with `sha256sum -c SHA256SUMS` on Linux, or
`shasum -a 256 -c SHA256SUMS` on macOS. The binaries are neither signed nor
notarized, so Windows SmartScreen and macOS Gatekeeper show a warning.
