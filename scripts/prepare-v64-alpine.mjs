#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { gunzipSync, gzipSync } from 'node:zlib';

const ALPINE = {
  version: '3.24.0',
  name: 'alpine-virt-3.24.0-x86_64.iso',
  url: 'https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64/alpine-virt-3.24.0-x86_64.iso',
  sha256: '6cd1a38ae05cf96a5d0cbb2ddd6c630834babfeca1ecc5d1f05ec0b06b886102',
};
const ref = 'alpine-3-24-x86-64';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const cache = join(root, '.tmp', 'v64-alpine');
const target = join(root, 'apps', 'web', 'public', 'images', ref);
const iso = join(cache, ALPINE.name);
const overlayRoot = join(cache, 'lumiboot-apkovl');
const initramfsOverlayRoot = join(cache, 'lumiboot-initramfs-overlay');
const apkovl = join(initramfsOverlayRoot, 'lumiboot.apkovl.tar.gz');

async function hashFile(path) {
  const hash = createHash('sha256');
  const input = createReadStream(path);
  input.on('data', (chunk) => hash.update(chunk));
  await finished(input);
  return hash.digest('hex');
}

function cpioHex(value) {
  return value.toString(16).padStart(8, '0');
}

function writeTarOctal(header, offset, length, value) {
  header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
}

/** Creates a portable ustar entry with an explicit Unix mode. */
function createTarEntry(name, data, mode) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  writeTarOctal(header, 100, 8, mode);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, data.length);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write('root', 265, 32, 'ascii');
  header.write('root', 297, 32, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

function createTarGz(entries) {
  return gzipSync(
    Buffer.concat([
      ...entries.map(({ name, data, mode }) => createTarEntry(name, data, mode)),
      Buffer.alloc(1024),
    ]),
    { level: 9 },
  );
}

/** Builds one SVR4 `newc` record without unpacking Linux symlinks on Windows. */
function createCpioEntry(name, data, mode = 0o100644) {
  const encodedName = Buffer.from(`${name}\0`);
  const header = Buffer.from(
    `070701${[1, mode, 0, 0, 1, 0, data.length, 0, 0, 0, 0, encodedName.length, 0]
      .map(cpioHex)
      .join('')}`,
  );
  const namePadding = Buffer.alloc((4 - ((header.length + encodedName.length) % 4)) % 4);
  const dataPadding = Buffer.alloc((4 - (data.length % 4)) % 4);
  return Buffer.concat([header, encodedName, namePadding, data, dataPadding]);
}

/** Inserts files before the final cpio trailer and emits one gzip stream. */
function addFilesToInitramfs(compressedInitramfs, entries) {
  const archive = gunzipSync(compressedInitramfs);
  const trailerName = Buffer.from('TRAILER!!!\0');
  const trailerNameOffset = archive.lastIndexOf(trailerName);
  const trailerHeaderOffset = trailerNameOffset - 110;
  if (
    trailerNameOffset < 110 ||
    archive.subarray(trailerHeaderOffset, trailerHeaderOffset + 6).toString() !== '070701'
  ) {
    throw new Error('Unable to locate the final SVR4 cpio trailer in Alpine initramfs.');
  }
  return gzipSync(
    Buffer.concat([
      archive.subarray(0, trailerHeaderOffset),
      ...entries.map(({ name, data, mode }) => createCpioEntry(name, data, mode)),
      archive.subarray(trailerHeaderOffset),
    ]),
    { level: 9 },
  );
}

await mkdir(cache, { recursive: true });
await mkdir(target, { recursive: true });
let valid = false;
try {
  valid = (await hashFile(iso)) === ALPINE.sha256;
} catch {
  valid = false;
}
if (!valid) {
  const response = await fetch(ALPINE.url);
  if (!response.ok || !response.body)
    throw new Error(`Alpine download failed: HTTP ${response.status}`);
  const output = createWriteStream(iso);
  await finished(Readable.fromWeb(response.body).pipe(output));
}
const isoHash = await hashFile(iso);
if (isoHash !== ALPINE.sha256) throw new Error(`Alpine ISO SHA-256 mismatch: ${isoHash}`);

const unpack = spawnSync(
  'tar',
  ['-xf', iso, '-C', cache, 'boot/vmlinuz-virt', 'boot/initramfs-virt'],
  { encoding: 'utf8' },
);
if (unpack.status !== 0)
  throw new Error(`Unable to extract Alpine ISO: ${unpack.stderr || unpack.stdout}`);

const outputIso = join(target, ALPINE.name);
const outputKernel = join(target, 'vmlinuz-virt');
const outputInitrd = join(target, 'initramfs-virt');
await copyFile(iso, outputIso);
await copyFile(join(cache, 'boot', 'vmlinuz-virt'), outputKernel);

await rm(overlayRoot, { recursive: true, force: true });
await rm(initramfsOverlayRoot, { recursive: true, force: true });
await mkdir(join(overlayRoot, 'etc', 'apk'), { recursive: true });
await mkdir(join(overlayRoot, 'home', 'lumiboot'), { recursive: true });
await mkdir(join(overlayRoot, 'usr', 'local', 'sbin'), { recursive: true });
await mkdir(initramfsOverlayRoot, { recursive: true });

const inittab = `# LumiBoot: initialize the disposable account before OpenRC starts services.
::sysinit:/usr/local/sbin/lumiboot-setup
::sysinit:/sbin/openrc sysinit
::sysinit:/sbin/openrc boot
::wait:/sbin/openrc default
::shutdown:/sbin/openrc shutdown

# Immediate login on both the VGA console and the serial console.
tty1::respawn:/sbin/getty -n -l /usr/local/sbin/lumiboot-autologin 38400 tty1
ttyS0::respawn:/sbin/getty -n -l /usr/local/sbin/lumiboot-autologin -L 115200 ttyS0 vt100
`;
const setupScript = `#!/bin/sh
set -eu

hostname lumiboot
if ! grep -q '^lumiboot:' /etc/group; then
  addgroup -g 1000 lumiboot
fi
if ! id -u lumiboot >/dev/null 2>&1; then
  adduser -D -u 1000 -G lumiboot -h /home/lumiboot -s /bin/ash lumiboot
fi
passwd -d lumiboot >/dev/null 2>&1 || true
for group in wheel audio video input netdev; do
  addgroup lumiboot "$group" >/dev/null 2>&1 || true
done
mkdir -p /home/lumiboot
chown -R lumiboot:lumiboot /home/lumiboot
`;
const autologinScript = `#!/bin/sh
terminal=$(tty)
/usr/bin/setsid -c /bin/login -f lumiboot <"$terminal" >"$terminal" 2>&1 &
wait $!
`;

await writeFile(join(overlayRoot, 'etc', 'apk', 'world'), 'alpine-base\ndoas\n');
await writeFile(join(overlayRoot, 'etc', 'doas.conf'), 'permit nopass :wheel\n');
await writeFile(join(overlayRoot, 'etc', 'hostname'), 'lumiboot\n');
await writeFile(join(overlayRoot, 'etc', 'inittab'), inittab);
await writeFile(
  join(overlayRoot, 'home', 'lumiboot', '.profile'),
  "export PS1='lumiboot@lumiboot:\\w\\$ '\n",
);
await writeFile(join(overlayRoot, 'usr', 'local', 'sbin', 'lumiboot-setup'), setupScript);
await writeFile(join(overlayRoot, 'usr', 'local', 'sbin', 'lumiboot-autologin'), autologinScript);
await writeFile(
  apkovl,
  createTarGz([
    {
      name: 'etc/apk/world',
      data: await readFile(join(overlayRoot, 'etc', 'apk', 'world')),
      mode: 0o644,
    },
    {
      name: 'etc/doas.conf',
      data: await readFile(join(overlayRoot, 'etc', 'doas.conf')),
      mode: 0o400,
    },
    {
      name: 'etc/hostname',
      data: await readFile(join(overlayRoot, 'etc', 'hostname')),
      mode: 0o644,
    },
    {
      name: 'etc/inittab',
      data: await readFile(join(overlayRoot, 'etc', 'inittab')),
      mode: 0o644,
    },
    {
      name: 'home/lumiboot/.profile',
      data: await readFile(join(overlayRoot, 'home', 'lumiboot', '.profile')),
      mode: 0o644,
    },
    {
      name: 'usr/local/sbin/lumiboot-setup',
      data: await readFile(join(overlayRoot, 'usr', 'local', 'sbin', 'lumiboot-setup')),
      mode: 0o755,
    },
    {
      name: 'usr/local/sbin/lumiboot-autologin',
      data: await readFile(join(overlayRoot, 'usr', 'local', 'sbin', 'lumiboot-autologin')),
      mode: 0o755,
    },
  ]),
);

const originalInitramfs = join(cache, 'boot', 'initramfs-virt');
const extractInit = spawnSync('tar', ['-xOf', originalInitramfs, 'init'], {
  encoding: 'utf8',
  maxBuffer: 2 * 1024 * 1024,
});
if (extractInit.status !== 0)
  throw new Error(`Unable to read Alpine init: ${extractInit.stderr || extractInit.stdout}`);
const repositoryScan = 'echo "$ovl" | cat - "$repofile" | while read -r dir; do';
const patchedRepositoryScan =
  '{ [ "$ovl" = "/lumiboot.apkovl.tar.gz" ] || echo "$ovl"; cat "$repofile"; } | while read -r dir; do';
const patchedInit = extractInit.stdout.replace(repositoryScan, patchedRepositoryScan);
if (patchedInit === extractInit.stdout)
  throw new Error('Unable to patch the embedded-apkovl repository scan in Alpine init.');

await writeFile(
  outputInitrd,
  addFilesToInitramfs(await readFile(originalInitramfs), [
    {
      name: 'lumiboot.apkovl.tar.gz',
      data: await readFile(apkovl),
      mode: 0o100644,
    },
    { name: 'init', data: Buffer.from(patchedInit), mode: 0o100755 },
  ]),
);

async function fileRef(path, name) {
  const info = await stat(path);
  return {
    url: `/images/${ref}/${name}`,
    sha256: await hashFile(path),
    size: info.size,
    version: ALPINE.version,
  };
}

const manifest = {
  ref,
  architecture: 'x86_64',
  memoryMiB: 1024,
  vgaMemoryMiB: 32,
  license: 'Alpine Linux packages: their respective open-source licenses',
  files: {
    disk: await fileRef(outputIso, ALPINE.name),
    bzimage: await fileRef(outputKernel, 'vmlinuz-virt'),
    initrd: await fileRef(outputInitrd, 'initramfs-virt'),
  },
  boot: {
    cmdline:
      'console=tty0 console=ttyS0,115200 earlyprintk=serial,ttyS0,115200 loglevel=4 apkovl=/lumiboot.apkovl.tar.gz modules=loop,squashfs,sd-mod,usb-storage',
  },
};
await writeFile(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(
  join(target, 'provenance.txt'),
  `Source: ${ALPINE.url}\nISO SHA-256: ${ALPINE.sha256}\nv64 revision: 74d2bafcc7d568e2ab4374804e176f1a8a350f61\n`,
);
console.log(`✓ Alpine ${ALPINE.version} x86_64 prepared in apps/web/public/images/${ref}/`);
