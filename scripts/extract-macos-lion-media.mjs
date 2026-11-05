#!/usr/bin/env node
// Experimental macOS Lion x64 media extractor:
// InstallMacOSX.dmg -> InstallMacOSX.pkg (xar) -> InstallESD.dmg.
// Measured on the real Apple installer (7-Zip 26.03, 2026-11-04): InstallESD.dmg is a
// DIRECT member of the xar, not a file inside the Payload cpio. The Payload extracted by
// 7-Zip is already a plain cpio ("070707"), not gzip: the extractor sniffs the magic and
// only gunzips when it really is a gzip stream. It stays an optional fallback.
// A UDIF image ends with a 512-byte trailer that STARTS with `koly`; its last four bytes
// are part of the image-offset field (zeros here), so the magic lives at `size - 512`.
// No Apple binary is versioned or distributed: every extracted file lands in a Git-ignored
// build/ directory. Nothing here integrates macOS into LumiBoot.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, open, mkdir, readdir, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { delimiter, extname, join, resolve, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

const REF = 'macos-lion-x64';
/** Default working directory, relative to the repository root (Git-ignored). */
export const DEFAULT_OUT = `images/${REF}/build`;

/** UDIF trailer magic: the 512-byte trailer of an Apple disk image STARTS with `koly`. */
const KOLY = [0x6b, 0x6f, 0x6c, 0x79];
/** Length of the UDIF trailer block the magic is read from (`koly` at its offset 0). */
const UDIF_TRAILER_LENGTH = 512;
/** HFS+ volume header lives 1024 bytes into the volume and starts with `H+` (or `HX` for HFSX). */
const HFS_PLUS_OFFSET = 1024;

function usage() {
  return `Usage: node scripts/extract-macos-lion-media.mjs [options]

Unpacks an operator-supplied Apple InstallMacOSX.dmg (macOS Lion 10.7 x64) down to
InstallESD.dmg, the image that carries BaseSystem.dmg and Packages/.
Nothing is downloaded and nothing is committed: the output is Git-ignored.

  --source <path>   Apple UDIF disk image (InstallMacOSX.dmg). Required; must end in
                    .dmg. Keep it outside the repository.
  --out <dir>       Working directory (default ${DEFAULT_OUT})
  --check           Verify an already extracted tree without writing anything. Only
                    InstallESD.dmg is required; prints its size and SHA-256
  --force           Allow writing into a non-empty --out
  --json            Print a JSON summary on stdout (logs on stderr)
  -h, --help        Show this help

Steps: DMG -> InstallMacOSX.pkg (xar) -> InstallESD.dmg (a direct xar member).
The Payload cpio is unpacked as a fallback check; it is never required.

Example:
  pnpm assets:macos:extract -- --source "<path>\\InstallMacOSX.dmg"

HFS+ restore (BaseSystem.dmg -> bootable volume) and the QEMU procedure are not
automated here; see images/${REF}/README.md.
`;
}

function log(message) {
  process.stderr.write(`${message}\n`);
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested without any DMG or 7-Zip installation)
// ---------------------------------------------------------------------------

/**
 * Parses the command line. A lone `--` injected by pnpm is skipped.
 * Options: --source, --out, --force, --check, --json, -h/--help.
 */
export function parseArgs(argv) {
  const options = { source: undefined, out: DEFAULT_OUT };
  const flags = { force: false, check: false, json: false, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    // A lone `--` injected by pnpm is skipped, never treated as an unknown option.
    if (arg === '--') continue;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    const value = () => {
      if (inline !== undefined) return inline;
      i += 1;
      if (i >= argv.length) throw new Error(`Option ${name} requires a value.`);
      return argv[i];
    };

    switch (name) {
      case '--source':
        options.source = value();
        break;
      case '--out':
        options.out = value();
        break;
      case '--force':
        flags.force = true;
        break;
      case '--check':
        flags.check = true;
        break;
      case '--json':
        flags.json = true;
        break;
      case '--help':
      case '-h':
        flags.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${name}`);
    }
  }

  return { options, flags };
}

/** Rejects a missing source and any source that is not an Apple `.dmg`. Returns the path. */
export function assertDmgSource(sourcePath) {
  if (typeof sourcePath !== 'string' || sourcePath.trim().length === 0) {
    throw new Error(
      'Missing source: provide --source "<path>\\InstallMacOSX.dmg" (the Apple installer DMG).',
    );
  }
  if (extname(sourcePath).toLowerCase() !== '.dmg') {
    throw new Error(
      `Refused: "${basename(sourcePath)}" is not a .dmg image. ` +
        'An Apple UDIF installer (InstallMacOSX.dmg) is required; a .pkg, an .iso or a ' +
        'renamed file cannot be unpacked by this pipeline.',
    );
  }
  return sourcePath;
}

/**
 * 7-Zip candidates, in resolution order: `7z.exe` in every PATH entry, then the two
 * standard Windows install directories, then $SEVEN_ZIP. Pure: no filesystem access.
 */
export function sevenZipCandidates({ pathValue = '', env = {}, platform = process.platform } = {}) {
  const executable = platform === 'win32' ? '7z.exe' : '7z';
  const candidates = [];

  for (const entry of String(pathValue ?? '').split(delimiter)) {
    if (entry.length > 0) candidates.push(join(entry, executable));
  }

  if (platform === 'win32') {
    candidates.push('C:\\Program Files\\7-Zip\\7z.exe');
    candidates.push('C:\\Program Files (x86)\\7-Zip\\7z.exe');
  } else {
    candidates.push('/usr/bin/7z', '/usr/local/bin/7z', '/opt/homebrew/bin/7z');
  }

  if (typeof env?.SEVEN_ZIP === 'string' && env.SEVEN_ZIP.length > 0) {
    candidates.push(env.SEVEN_ZIP);
  }

  return candidates;
}

/**
 * First candidate that exists, de-duplicated. `exists` is injectable so the
 * resolution order is testable without installing 7-Zip.
 */
export function resolveSevenZip(candidates, exists = existsSync) {
  const seen = new Set();
  for (const candidate of candidates ?? []) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (exists(candidate)) return candidate;
    } catch {
      // An unreadable candidate is simply skipped.
    }
  }
  return undefined;
}

/** True when a buffer starts with the gzip magic `1f 8b`. */
export function isGzipMagic(bytes) {
  return Boolean(bytes) && bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * True when the buffer starts with the UDIF trailer magic `koly`.
 * Pass the LAST 512 bytes of the image: the magic sits at `size - 512`, and the
 * four last bytes of the file are the tail of the image-offset field (zeros),
 * never `koly`.
 */
export function detectUdif(bytes) {
  if (!bytes || bytes.length < 4) return false;
  return (
    bytes[0] === KOLY[0] && bytes[1] === KOLY[1] && bytes[2] === KOLY[2] && bytes[3] === KOLY[3]
  );
}

/** `H+` / `HX` at offset 1024 of the volume, i.e. the HFS+ (or HFSX) signature. */
export function detectHfsPlus(bytes, offset = HFS_PLUS_OFFSET) {
  if (!bytes || bytes.length < offset + 2) return null;
  const signature = String.fromCharCode(bytes[offset], bytes[offset + 1]);
  return signature === 'H+' || signature === 'HX' ? signature : null;
}

/** The first four bytes as printable ASCII when possible, otherwise as hex; null when absent. */
function describeFirstFour(bytes) {
  if (!bytes || bytes.length < 4) return null;
  const chunk = Buffer.from(bytes.subarray(0, 4));
  const printable = [...chunk].every((byte) => byte >= 0x20 && byte < 0x7f);
  return printable ? chunk.toString('latin1') : `0x${chunk.toString('hex')}`;
}

/**
 * Combines the two measured probes into a summary. The caller supplies the head
 * (first bytes) and the trailer (last 512 bytes) it actually read, so a short read
 * shows up as `headBytes`/`trailerBytes` instead of a guess.
 */
export function describeMagic({ head, trailer } = {}) {
  const udif = detectUdif(trailer);
  const hfsPlusSignature = detectHfsPlus(head);
  let kind = 'unknown';
  if (udif) kind = 'udif';
  else if (hfsPlusSignature === 'H+') kind = 'hfs+';
  else if (hfsPlusSignature === 'HX') kind = 'hfsx';

  return {
    udif,
    kind,
    trailerMagic: describeFirstFour(trailer),
    hfsPlusSignature,
    headBytes: head ? head.length : 0,
    trailerBytes: trailer ? trailer.length : 0,
  };
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function sevenZipHelp() {
  return [
    '7-Zip was not found.',
    '  Looked for 7z.exe in PATH, then C:\\Program Files\\7-Zip\\7z.exe,',
    '  C:\\Program Files (x86)\\7-Zip\\7z.exe and $SEVEN_ZIP.',
    '  Windows: winget install 7zip.7zip',
    '  macOS: no 7-Zip needed, use hdiutil + pkgutil:',
    '    hdiutil attach -noverify -readonly "<path>/InstallMacOSX.dmg"',
    '    pkgutil --expand "/Volumes/InstallMacOSX/InstallMacOSX.pkg" build/pkg',
    '  Linux/WSL: sudo apt install p7zip-full dmg2img',
    '    dmg2img -i InstallMacOSX.dmg -o InstallMacOSX.img',
    `  Full procedure: images/${REF}/README.md`,
  ].join('\n');
}

async function readBytes(filePath, position, length) {
  const size = length;
  if (size <= 0) return Buffer.alloc(0);
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, Math.max(0, position));
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Depth-first search for the first matching file; a top-level match wins. */
async function findEntry(root, predicate) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = join(root, entry.name);
    if (predicate(entry.name, full)) return full;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findEntry(join(root, entry.name), predicate);
    if (found !== undefined) return found;
  }

  return undefined;
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** Refuses to write into a non-empty output directory unless --force is given. */
async function assertWritableTarget(outDir, force) {
  if (!(await pathExists(outDir))) return;
  const entries = await readdir(outDir);
  if (entries.length > 0 && !force) {
    throw new Error(
      `Refused: the output directory is not empty (${outDir}). ` +
        'Use --check to verify it, --force to overwrite it, or --out to write elsewhere.',
    );
  }
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath, { highWaterMark: 8 * 1024 * 1024 })) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function sevenZipRun(sevenZip, args) {
  const result = spawnSync(sevenZip, args, { stdio: 'inherit' });
  if (result.error) {
    throw new Error(`7-Zip failed to start (${sevenZip}): ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `7-Zip exited with status ${result.status}: ${[sevenZip, ...args].join(' ')}\n` +
        '  If the archive is not recognised, check that this 7-Zip build reads xar (.pkg) ' +
        'and HFS+; otherwise use hdiutil + pkgutil on macOS, or dmg2img on Linux.',
    );
  }
}

async function gunzipFile(sourcePath, destination) {
  await pipeline(createReadStream(sourcePath), createGunzip(), createWriteStream(destination));
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function logMagic(summary, filePath) {
  const parts = [`kind=${summary.kind}`, `udif=${summary.udif}`];
  parts.push(`trailer=${summary.trailerMagic ?? '(none read)'}`);
  parts.push(`hfs+=${summary.hfsPlusSignature ?? '(none at offset 1024)'}`);
  log(`  ${basename(filePath)}: ${parts.join(', ')}`);
  if (summary.kind === 'unknown') {
    log('  ℹ Neither a UDIF trailer nor an HFS+ signature was measured: check the file.');
  }
}

async function probe(filePath) {
  const info = await stat(filePath);
  const head = await readBytes(filePath, 0, HFS_PLUS_OFFSET + 4);
  // The UDIF trailer is the last 512 bytes; `koly` is at its first four bytes.
  const trailer = await readBytes(
    filePath,
    Math.max(0, info.size - UDIF_TRAILER_LENGTH),
    UDIF_TRAILER_LENGTH,
  );
  return { size: info.size, magic: describeMagic({ head, trailer }) };
}

async function runCheck(outDir, flags) {
  if (!(await pathExists(outDir))) {
    log(`✗ Nothing to check: ${outDir} does not exist.`);
    return 1;
  }

  log(`→ Checking ${outDir}`);

  // Only what the extractor actually produces is expected here: the xar archive under
  // dmg/, InstallESD.dmg under pkg/ (a direct xar member) and, for older layouts, an
  // extracted payload/. The source DMG is never copied: it is optional and only
  // mentioned when a copy happens to be present.
  const pkgDir = join(outDir, 'pkg');
  const sourcePath = await findEntry(outDir, (name) => name === 'InstallMacOSX.dmg');
  const pkgPath = await findEntry(outDir, (name) => name === 'InstallMacOSX.pkg');
  const esdInPkg = (await pathExists(pkgDir))
    ? await findEntry(pkgDir, (name) => name === 'InstallESD.dmg')
    : undefined;
  const esdPath = esdInPkg ?? (await findEntry(outDir, (name) => name === 'InstallESD.dmg'));
  const payloadDir = join(outDir, 'payload');

  const files = {};
  if (sourcePath !== undefined) {
    const info = await stat(sourcePath);
    files['InstallMacOSX.dmg'] = { path: sourcePath, size: info.size };
    log(`ℹ Source copy: ${sourcePath} (${info.size} bytes)`);
  }
  if (pkgPath !== undefined) {
    const info = await stat(pkgPath);
    files['InstallMacOSX.pkg'] = { path: pkgPath, size: info.size };
    log(`✓ InstallMacOSX.pkg: ${pkgPath} (${info.size} bytes)`);
  } else {
    log('ℹ InstallMacOSX.pkg: absent (optional; only InstallESD.dmg is required)');
  }
  if (await pathExists(payloadDir)) {
    log(`ℹ payload/: present (optional fallback tree, ${payloadDir})`);
  }

  if (esdPath === undefined) {
    log(
      '✗ InstallESD.dmg is missing: the extraction did not complete ' +
        '(expected under pkg/, or under payload/ for older layouts).',
    );
    return 1;
  }

  const esdInfo = await stat(esdPath);
  files['InstallESD.dmg'] = { path: esdPath, size: esdInfo.size };
  log(`✓ InstallESD.dmg: ${esdPath} (${esdInfo.size} bytes)`);
  const { magic } = await probe(esdPath);
  logMagic(magic, esdPath);
  log('→ Computing SHA-256 of InstallESD.dmg (streaming)…');
  const sha256 = await sha256File(esdPath);
  log(`  InstallESD.dmg: ${esdInfo.size} bytes, sha256=${sha256}`);

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ref: REF,
          out: outDir,
          files,
          installEsd: { path: esdPath, size: esdInfo.size, sha256, magic },
        },
        null,
        2,
      )}\n`,
    );
  }
  return 0;
}

async function runExtract(options, flags) {
  const sourcePath = resolve(assertDmgSource(options.source));
  if (!existsSync(sourcePath)) {
    throw new Error(
      `Source DMG not found: ${sourcePath}\n` +
        `  Provide the operator-supplied installer:\n` +
        `    pnpm assets:macos:extract -- --source "<path>\\InstallMacOSX.dmg"`,
    );
  }

  const outDir = resolve(options.out ?? DEFAULT_OUT);
  await assertWritableTarget(outDir, flags.force);

  const source = await probe(sourcePath);
  log(`→ Source: ${sourcePath} (${source.size} bytes)`);
  logMagic(source.magic, sourcePath);
  if (!source.magic.udif) {
    log(
      '  ℹ No UDIF trailer measured. Extraction still runs: 7-Zip reads the container it ' +
        'finds, but this is probably not the Apple installer DMG.',
    );
  }

  const sevenZip = resolveSevenZip(
    sevenZipCandidates({ pathValue: process.env.PATH, env: process.env }),
  );
  if (sevenZip === undefined) throw new Error(sevenZipHelp());
  log(`→ 7-Zip: ${sevenZip}`);

  await mkdir(outDir, { recursive: true });

  // 1. The DMG itself (UDIF -> HFS+ volume members).
  const dmgDir = join(outDir, 'dmg');
  log(`→ [1/3] Extracting the DMG to ${dmgDir}…`);
  sevenZipRun(sevenZip, ['x', sourcePath, `-o${dmgDir}`, '-y']);

  // 2. InstallMacOSX.pkg is a xar archive; 7-Zip lists its members.
  const pkgPath = await findEntry(dmgDir, (name) => name === 'InstallMacOSX.pkg');
  if (pkgPath === undefined) {
    throw new Error(
      `InstallMacOSX.pkg was not found under ${dmgDir}.\n` +
        '  Check that --source is the Apple Mac OS X Lion installer DMG and that 7-Zip ' +
        'can read HFS+ (it lists the volume members, including the .pkg).',
    );
  }
  const pkgDir = join(outDir, 'pkg');
  log(`→ [2/3] Extracting the xar archive ${basename(pkgPath)} to ${pkgDir}…`);
  sevenZipRun(sevenZip, ['x', pkgPath, `-o${pkgDir}`, '-y']);

  // 3. InstallESD.dmg is a DIRECT member of the xar on the real Lion installer
  //    (measured 2026-11-04): it is not nested inside the Payload. Older layouts do
  //    nest it there, so the Payload is still unpacked as a fallback and its failure
  //    is tolerated once InstallESD.dmg has been found.
  log('→ [3/3] Locating InstallESD.dmg…');
  let esdPath = await findEntry(pkgDir, (name) => name === 'InstallESD.dmg');
  let esdLayout = esdPath === undefined ? undefined : 'xar-member';

  const payloadDir = join(outDir, 'payload');
  let cpioPath;
  const payloadPath = await findEntry(pkgDir, (name) => name === 'Payload');
  if (payloadPath === undefined) {
    if (esdPath === undefined) {
      throw new Error(
        `Neither InstallESD.dmg nor Payload was found under ${pkgDir}.\n` +
          '  The xar was extracted but carries no installer image: verify that ' +
          '--source is a complete Apple Lion installer, and that this 7-Zip build ' +
          'expands xar archives (on macOS: pkgutil --expand "<pkg>" build/pkg).',
      );
    }
    log('  ℹ No Payload member: InstallESD.dmg is a direct xar member, nothing else is needed.');
  } else {
    log('  → Unpacking the Payload (cpio) as a fallback check…');
    cpioPath = join(pkgDir, 'Payload.cpio');
    try {
      // 7-Zip already decompresses the xar member, so `Payload` is a plain cpio on the
      // real Lion installer (measured: it starts with "070707"). Other tools leave it
      // gzipped. Sniff the magic instead of assuming gzip.
      const magic = await readBytes(payloadPath, 0, 2);
      if (isGzipMagic(magic)) {
        await gunzipFile(payloadPath, cpioPath);
      } else {
        log('  ℹ Payload is already a plain cpio (the xar member was decompressed by 7-Zip).');
        await copyFile(payloadPath, cpioPath);
      }
      sevenZipRun(sevenZip, ['x', cpioPath, `-o${payloadDir}`, '-y']);
      if (esdPath !== undefined) {
        log(
          `  ℹ Payload unpacked to ${payloadDir} (not needed: InstallESD.dmg is a direct xar member).`,
        );
      }
    } catch (error) {
      if (esdPath === undefined) throw error;
      log(
        `  ℹ Payload not unpacked (${error.message.split('\n')[0]}); ` +
          'InstallESD.dmg is already extracted, continuing.',
      );
    }
    if (esdPath === undefined) {
      esdPath = await findEntry(payloadDir, (name) => name === 'InstallESD.dmg');
      if (esdPath !== undefined) esdLayout = 'payload';
    }
  }

  if (esdPath === undefined) {
    throw new Error(
      `InstallESD.dmg was not found under ${payloadDir} either.\n` +
        '  The Payload was unpacked but holds no installer image: verify that ' +
        '--source is a complete Apple Lion installer.',
    );
  }

  const esd = await probe(esdPath);
  logMagic(esd.magic, esdPath);
  log('→ Computing SHA-256 of InstallESD.dmg (streaming)…');
  const sha256 = await sha256File(esdPath);

  log(`✓ InstallESD.dmg extracted: ${esdPath}`);
  log(`  size=${esd.size} bytes`);
  log(`  sha256=${sha256}`);
  log(`  BaseSystem.dmg and Packages/ live inside it; the boot procedure is not automated.`);
  log(`  Next: see images/${REF}/README.md (HFS+ restore, QEMU probe, v64 gaps).`);

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ref: REF,
          out: outDir,
          source: { fileName: basename(sourcePath), size: source.size, magic: source.magic },
          steps: {
            dmg: dmgDir,
            pkg: pkgPath,
            payload: payloadPath,
            cpio: cpioPath,
            payloadTree: payloadDir,
          },
          installEsd: {
            path: esdPath,
            size: esd.size,
            sha256,
            magic: esd.magic,
            layout: esdLayout,
          },
        },
        null,
        2,
      )}\n`,
    );
  }
  return 0;
}

async function main() {
  const { options, flags } = parseArgs(process.argv.slice(2));
  if (flags.help) {
    process.stdout.write(usage());
    return 0;
  }
  if (flags.check) return runCheck(resolve(options.out ?? DEFAULT_OUT), flags);
  return runExtract(options, flags);
}

// Importing this module from a test must not run the extractor.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main()
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`✗ ${error.message}\n`);
      process.exitCode = 1;
    });
}
