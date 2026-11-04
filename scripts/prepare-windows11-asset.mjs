#!/usr/bin/env node
// Windows 11 x64 manifest generator: delegates to prepare-windows7-asset.mjs.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const generator = join(here, 'prepare-windows7-asset.mjs');

const REF = 'windows-11-x64';
const DISPLAY_NAME = 'Windows 11 x64';
const ARCHITECTURE = 'x86_64';
const MEMORY_MIB = '4096';
const VGA_MIB = '32';
const OUT_DIR = resolve(repoRoot, 'images', REF);
const DEFAULT_SOURCE = process.env.WINDOWS11_IMG ?? join(OUT_DIR, 'disk.img');
// OVMF NVRAM store installed with the disk: it carries the Windows Boot Manager entry.
const DEFAULT_FIRMWARE_VARS = join(OUT_DIR, 'uefi-vars.fd');

const NOTES = [
  `Operator-provided x86-64 RAW disk (Windows 11, already installed), served in place (images/${REF}/disk.img): never copied, git-ignored, never distributed.`,
  'UEFI/GPT disk (ESP + Windows Boot Manager) booted by v64 through OVMF on Q35/ICH9 AHCI over HTTP Range (hda.async = true). The OVMF variable store is images/windows-11-x64/uefi-vars.fd.',
  'No SHA-256 for the 64 GiB disk: documented by size and mtime (the disk is git-ignored).',
];

/** Non-raw virtual disk extensions, rejected for a disk boot. */
const NOT_RAW_EXTENSIONS = new Map([
  ['.qcow', 'QCOW'],
  ['.qcow2', 'QCOW2'],
  ['.vhd', 'VHD'],
  ['.vhdx', 'VHDX'],
  ['.vmdk', 'VMDK'],
  ['.vdi', 'VDI'],
]);

function usage() {
  return `Usage: node scripts/prepare-windows11-asset.mjs [options]

Windows 11 x64 generator (delegates to prepare-windows7-asset.mjs).

  --source <path>         ALREADY INSTALLED x86-64 UEFI/GPT RAW disk (default:
                          images/${REF}/disk.img, or WINDOWS11_IMG).
                          A standalone ISO or a QCOW2 is rejected.
                          A disk outside the repository records no local path.
  --firmware-vars <path>  OVMF variable store served next to the disk (default:
                          images/${REF}/uefi-vars.fd). It carries the Windows
                          Boot Manager entry and must be kept with the disk.
  --engine <v86|v64>      Engine recorded by the manifest (default v64).
  --memory-mib <n>        Recommended guest memory (default ${MEMORY_MIB})
  --vga-mib <n>           VGA memory (default ${VGA_MIB})
  --out <dir>             Output directory (default images/${REF})
  --check                 Verify the existing manifest without writing anything
                          (checks the disk and the UEFI variable store; requires
                          --source when the manifest comes from an external disk)
  --force                 Allow overwriting the existing manifest
  --skip-hash             Do not compute the SHA-256 of the disk (documents size
                          + mtime; the variable store is always hashed)
  --resume                Reuse the existing SHA-256 when size+mtime match
  --json                  Print the manifest on stdout (logs on stderr)
  --copy-to <path>        Optional verified copy (never the source, never public/)
  -h, --help              Show this help

Example:
  pnpm assets:windows11:prepare -- --source "<path>/Windows11-x64.img"
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

/** Rejects media that cannot boot from a disk: ISO and container formats. */
function assertBootableRawDisk(sourcePath, requestedFormat) {
  if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
    throw new Error('Missing source disk: provide --source <RAW disk> or WINDOWS11_IMG.');
  }
  const format = (requestedFormat ?? '').toLowerCase();
  const extension = extname(sourcePath).toLowerCase();

  if (format === 'iso' || extension === '.iso') {
    throw new Error(
      'Refused: a standalone ISO image is not a bootable disk ' +
        '(disk-boot pipeline). Provide the RAW disk of an already installed Windows 11.',
    );
  }
  if (NOT_RAW_EXTENSIONS.has(extension)) {
    const kind = NOT_RAW_EXTENSIONS.get(extension);
    throw new Error(
      `Refused: ${kind} format is not supported (the disk-boot pipeline requires a RAW disk). ` +
        'Convert the disk to RAW first, then re-run with --source.',
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

  // Windows 11 x64 values (v64 + OVMF), then the operator options.
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
    '--provenance',
    `images/${REF}/disk.img (local disk served in place)`,
    ...NOTES.flatMap((note) => ['--note', note]),
  ];
  if (!check) {
    // Without --check, pass the default disk; --check follows the recorded path.
    defaults.push('--source', DEFAULT_SOURCE);
    // The NVRAM store is a generation input; --check finds it next to the manifest
    // (or takes the operator's --firmware-vars) instead of a hard-coded default.
    defaults.push('--firmware-vars', DEFAULT_FIRMWARE_VARS);
  }

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
          '  Prepare an already installed x86-64 UEFI/GPT RAW disk, then re-run:\n' +
          `    pnpm assets:windows11:prepare -- --source "<path\\\\disk.img>"\n`,
      );
      return 1;
    }

    // The OVMF store is part of the boot: without it Windows Boot Manager is lost.
    const firmwareVars = lastValue(args, '--firmware-vars');
    if (firmwareVars !== undefined && !existsSync(resolve(firmwareVars))) {
      process.stderr.write(
        `✗ No OVMF variable store found at ${resolve(firmwareVars)}.\n` +
          '  Keep the uefi-vars.fd file installed with the disk (it holds the Windows ' +
          'Boot Manager entry), or pass --firmware-vars "<path>".\n',
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
