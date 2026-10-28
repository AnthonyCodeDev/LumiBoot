#!/usr/bin/env node
// Builds the manifest of the Windows 10 x86 disk supplied locally, by delegating
// to prepare-windows7-asset.mjs with the Windows 10 values pinned; operator
// options come after and win.
//
//   pnpm assets:windows10:prepare -- --source "<path>/Windows10-32bit.img"
//   pnpm assets:windows10:check
//
// Writes images/windows-10-x86/manifest.json. The disk is served in place.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const generator = join(here, 'prepare-windows7-asset.mjs');

const REF = 'windows-10-x86';
const DISPLAY_NAME = 'Windows 10 x86';
const ARCHITECTURE = 'i386';
const MEMORY_MIB = '2048';
const VGA_MIB = '16';
const OUT_DIR = resolve(repoRoot, 'images', REF);
const DEFAULT_SOURCE = process.env.WINDOWS10_IMG ?? join(OUT_DIR, 'disk.img');

const NOTES = [
  `Operator-provided x86 RAW disk (Windows 10, already installed), served in place (images/${REF}/disk.img): never copied, git-ignored, never distributed.`,
  'Booted by the BIOS under v86 over HTTP Range (hda.async = true), never as a cdrom.',
];

/** Non-raw virtual disk extensions, rejected for an `hda` boot. */
const NOT_RAW_EXTENSIONS = new Map([
  ['.qcow', 'QCOW'],
  ['.qcow2', 'QCOW2'],
  ['.vhd', 'VHD'],
  ['.vhdx', 'VHDX'],
  ['.vmdk', 'VMDK'],
  ['.vdi', 'VDI'],
]);

function usage() {
  return `Usage: node scripts/prepare-windows10-asset.mjs [options]

Windows 10 x86 generator (delegates to prepare-windows7-asset.mjs).

  --source <path>         ALREADY INSTALLED x86 RAW disk (default:
                          images/${REF}/disk.img, or WINDOWS10_IMG).
                          A standalone ISO or a QCOW2 is rejected.
                          A disk outside the repository records no local path.
  --out <dir>             Output directory (default images/${REF})
  --check                 Verify the existing manifest without writing anything
                          (requires --source when the manifest comes from an
                          external disk, since no path is recorded)
  --force                 Allow overwriting the existing manifest
  --skip-hash             Do not compute the SHA-256 (documents size + mtime)
  --resume                Reuse the existing SHA-256 when size+mtime match
  --json                  Print the manifest on stdout (logs on stderr)
  --copy-to <path>        Optional verified copy (never the source, never public/)
  -h, --help              Show this help

Example:
  pnpm assets:windows10:prepare -- --source "<path>/Windows10-32bit.img"
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

/** Rejects media that cannot boot from an async `hda`: ISO and container formats. */
function assertBootableRawDisk(sourcePath, requestedFormat) {
  if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
    throw new Error('Missing source disk: provide --source <RAW disk> or WINDOWS10_IMG.');
  }
  const format = (requestedFormat ?? '').toLowerCase();
  const extension = extname(sourcePath).toLowerCase();

  if (format === 'iso' || extension === '.iso') {
    throw new Error(
      'Refused: a standalone ISO image is not a bootable disk for hda ' +
        '(disk-boot pipeline). Provide the RAW disk of an already installed Windows 10.',
    );
  }
  if (NOT_RAW_EXTENSIONS.has(extension)) {
    const kind = NOT_RAW_EXTENSIONS.get(extension);
    throw new Error(
      `Refused: ${kind} format is not supported by async hda (the disk-boot pipeline requires a RAW disk). ` +
        'Convert the disk to RAW first, then re-run with --source.',
    );
  }
  if (format !== '' && format !== 'raw') {
    throw new Error(
      `Refused: format "${format}" is not supported (RAW is required for disk-boot).`,
    );
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

  // Windows 10 x86 values, then the operator options.
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
    '--out',
    OUT_DIR,
    '--provenance',
    `images/${REF}/disk.img (local disk served in place)`,
    ...NOTES.flatMap((note) => ['--note', note]),
  ];
  // Without --check, pass the default source; --check follows the recorded path.
  if (!check) defaults.push('--source', DEFAULT_SOURCE);

  const args = [...defaults, ...userArgs];

  if (!check) {
    const source = lastValue(args, '--source') ?? DEFAULT_SOURCE;
    const format = lastValue(args, '--format');
    assertBootableRawDisk(source, format);

    const absoluteSource = resolve(source);
    if (!existsSync(absoluteSource)) {
      process.stderr.write(
        `✗ No local "${REF}" image found.\n` +
          `  Expected source: ${absoluteSource}\n` +
          '  Prepare an already installed x86 RAW disk, then re-run:\n' +
          `    pnpm assets:windows10:prepare -- --source "<path\\\\disk.img>"\n`,
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
