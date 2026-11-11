#!/usr/bin/env node
// macOS Lion x64 manifest generator: delegates to prepare-windows7-asset.mjs.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const generator = join(here, 'prepare-windows7-asset.mjs');

const REF = 'macos-lion-x64';
const DISPLAY_NAME = 'macOS Lion';
const ARCHITECTURE = 'x86_64';
const MEMORY_MIB = '2048';
const VGA_MIB = '32';
const OUT_DIR = resolve(repoRoot, 'images', REF);
const DEFAULT_SOURCE = process.env.MACOS_LION_IMG ?? join(OUT_DIR, 'disk.img');
// OpenCore ESP, second media of the two-disk v64 layout (ESP on hda, disk on hdb).
const DEFAULT_ESP = process.env.MACOS_LION_ESP ?? join(OUT_DIR, 'esp.img');

const LICENSE =
  'Operator-supplied macOS Lion 10.7.5 image; Apple licensing restricts use to Apple-branded ' +
  'hardware; not distributed.';
const PROVENANCE =
  `images/${REF}/disk.img (installed Lion 10.7.5 volume, decontaminated, auto-login lumi) + ` +
  `images/${REF}/esp.img (OpenCore 1.0.8, no Apple kext)`;

const NOTES = [
  `Operator-provided 8 GiB RAW disk holding an installed macOS Lion 10.7.5 volume (decontaminated, auto-login lumi), served in place: git-ignored, never committed nor distributed.`,
  'Two-media v64 layout: the OpenCore 1.0.8 ESP is mounted on hda (SATA port 0) and the system disk on hdb, both read lazily over HTTP Range (async = true). The ESP contains no Apple kext.',
];

/** Extensions accepted for the system disk: a RAW image, nothing else. */
const RAW_EXTENSIONS = new Set(['.img', '.raw']);

/** Container or installer formats, named in the refusal to make it actionable. */
const NOT_RAW_EXTENSIONS = new Map([
  ['.iso', 'ISO'],
  ['.dmg', 'DMG'],
  ['.qcow', 'QCOW'],
  ['.qcow2', 'QCOW2'],
  ['.vhd', 'VHD'],
  ['.vhdx', 'VHDX'],
  ['.vmdk', 'VMDK'],
  ['.vdi', 'VDI'],
]);

function usage() {
  return `Usage: node scripts/prepare-macos-lion-asset.mjs [options]

macOS Lion x64 generator (delegates to prepare-windows7-asset.mjs).

  --source <path>         ALREADY INSTALLED x86_64 RAW disk of the Lion volume
                          (default: images/${REF}/disk.img, or MACOS_LION_IMG).
                          Only .img/.raw are accepted: an ISO, a DMG or a QCOW2 is
                          rejected. A disk outside the repository records no local
                          path.
  --esp <path>            OpenCore EFI System Partition of the two-media layout,
                          mounted on hda (default: images/${REF}/esp.img, or
                          MACOS_LION_ESP). It is copied next to the manifest and
                          hashed in full; it must carry no Apple binary.
  --engine <v86|v64>      Engine recorded by the manifest (default v64).
  --memory-mib <n>        Recommended guest memory (default ${MEMORY_MIB})
  --vga-mib <n>           VGA memory (default ${VGA_MIB})
  --out <dir>             Output directory (default images/${REF})
  --check                 Verify the existing manifest without writing anything
                          (disk + ESP; needs neither --source nor --esp, it follows
                          the recorded paths)
  --force                 Allow overwriting the existing manifest
  --skip-hash             Do not compute the SHA-256 of the disk (documents size
                          + mtime; the ESP is always hashed)
  --resume                Reuse the existing SHA-256 when size+mtime match
  --json                  Print the manifest on stdout (logs on stderr)
  --copy-to <path>        Optional verified copy (never the source, never public/)
  -h, --help              Show this help

Examples:
  pnpm assets:macoslion:prepare -- --source "<path>/disk.img"
  pnpm assets:macoslion:prepare -- --force
`;
}

/** Last value of a `--name value` or `--name=value` option. */
function lastValue(args, name) {
  let value;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name) {
      value = args[i + 1];
      i += 1;
    } else if (args[i].startsWith(`${name}=`)) {
      value = args[i].slice(name.length + 1);
    }
  }
  return value;
}

function hasFlag(args, ...names) {
  return args.some((arg) => names.includes(arg));
}

/** Rejects media that cannot boot as the system disk: anything but a RAW image. */
function assertBootableRawDisk(sourcePath, requestedFormat) {
  if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
    throw new Error('Missing source disk: provide --source <RAW disk> or MACOS_LION_IMG.');
  }
  const format = (requestedFormat ?? '').toLowerCase();
  const extension = extname(sourcePath).toLowerCase();

  if (NOT_RAW_EXTENSIONS.has(extension)) {
    const kind = NOT_RAW_EXTENSIONS.get(extension);
    throw new Error(
      `Refused: a ${kind} is not a bootable disk (.img or .raw required). ` +
        'Provide the RAW image of the already installed Lion volume (restored from the Apple ' +
        'installer), never the installer medium itself.',
    );
  }
  if (!RAW_EXTENSIONS.has(extension)) {
    throw new Error(
      `Refused: "${sourcePath}" is not a RAW disk image (.img or .raw required). ` +
        'Provide the RAW image of the already installed Lion volume.',
    );
  }
  if (format !== '' && format !== 'raw') {
    throw new Error(`Refused: format "${format}" is not supported (RAW is required for disk-boot).`);
  }
}

function runGenerator(args) {
  const result = spawnSync(process.execPath, [generator, ...args], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (result.error) {
    process.stderr.write(`✗ Failed to start the generator: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

function main() {
  // A lone `--` injected by pnpm is dropped before validation and forwarding.
  const userArgs = process.argv.slice(2).filter((arg) => arg !== '--');

  if (hasFlag(userArgs, '--help', '-h')) {
    process.stdout.write(usage());
    return 0;
  }

  const check = hasFlag(userArgs, '--check');

  // macOS Lion x64 values (v64, two-media layout), then the operator options.
  const defaults = [
    '--ref',
    REF,
    '--display-name',
    DISPLAY_NAME,
    '--architecture',
    ARCHITECTURE,
    '--memory-mib',
    MEMORY_MIB,
    '--vga-mib',
    VGA_MIB,
    '--engine',
    'v64',
    '--out',
    OUT_DIR,
    '--license',
    LICENSE,
    '--provenance',
    PROVENANCE,
    ...NOTES.flatMap((note) => ['--note', note]),
  ];
  if (!check) {
    // Without --check, pass the default pair; --check follows the recorded paths.
    defaults.push('--source', DEFAULT_SOURCE);
    defaults.push('--esp', DEFAULT_ESP);
  }

  const args = [...defaults, ...userArgs];

  if (!check) {
    const source = lastValue(args, '--source') ?? DEFAULT_SOURCE;
    const format = lastValue(args, '--format');
    assertBootableRawDisk(source, format);

    const absoluteSource = resolve(source);
    if (!existsSync(absoluteSource)) {
      process.stderr.write(
        `✗ No local "${REF}" disk image found.\n` +
          `  Expected source: ${absoluteSource}\n` +
          '  The disk image is supplied by the operator: it is the RAW image of an already\n' +
          '  installed Lion volume (restored from the Apple installer, see this directory\'s README).\n' +
          `  Place it at images/${REF}/disk.img, or point at it:\n` +
          '    pnpm assets:macoslion:prepare -- --source "<path\\disk.img>"\n',
      );
      return 1;
    }

    // Without the OpenCore ESP the two-media boot has no loader: fail, never
    // generate a manifest that claims an ESP which is not there.
    const esp = lastValue(args, '--esp') ?? DEFAULT_ESP;
    const absoluteEsp = resolve(esp);
    if (!existsSync(absoluteEsp)) {
      process.stderr.write(
        `✗ No OpenCore ESP image found.\n` +
          `  Expected ESP: ${absoluteEsp}\n` +
          '  The ESP is built by the operator (OpenCore 1.0.8, no Apple binary) and is the\n' +
          '  first media of the two-disk layout. Place it at\n' +
          `  images/${REF}/esp.img, or point at it:\n` +
          '    pnpm assets:macoslion:prepare -- --esp "<path\\esp.img>"\n',
      );
      return 1;
    }
  }

  return runGenerator(args);
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`✗ ${error.message}\n`);
  process.exitCode = 1;
}
