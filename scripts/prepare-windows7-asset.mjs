#!/usr/bin/env node
// Builds the manifest of a system disk supplied LOCALLY (e.g. Windows 7
// Professional SP1 x86) so it can be streamed to v86 over HTTP Range, without
// ever copying it into public/ or committing it.
//
//   node scripts/prepare-windows7-asset.mjs
//   node scripts/prepare-windows7-asset.mjs --source D:\media\winxp.img \
//       --ref windows-xp-x86 --display-name "Windows XP x86" --architecture i386
//   node scripts/prepare-windows7-asset.mjs --check
//   node scripts/prepare-windows7-asset.mjs --skip-hash   # documents method+size+mtime
//
// The disk is served IN PLACE: the manifest records `source.path` RELATIVE to the
// repository root (e.g. `images/windows-7-x86/disk.img`, `/` separators) and
// copies NOTHING into the repository. A disk OUTSIDE the repository (e.g.
// `--source D:\media\x.img`) records NO path: `source` becomes
// `{ external: true, size, mtimeMs }`. A local absolute path (drive letter plus
// home directory) is meaningless on another machine and must never be published;
// `--check` then explicitly requires `--source`.
//
// Guarantees:
//   - the source file is opened READ-ONLY and is NEVER modified, truncated or
//     overwritten (no write ever targets that path);
//   - the optional copy (`--copy-to`) is refused when it would target the source
//     itself or a `public/` directory, and is only written once the streamed
//     SHA-256 has been verified;
//   - the SHA-256 is computed in streaming mode (8 MiB per chunk), never by
//     loading the whole 32 GiB into memory;
//   - the default output `images/<ref>/` is ignored by Git.
//
// The produced manifest is validated by `parseLocalDiskManifest` (tests
// `packages/vm-assets/src/local-disk.test.ts` and `tests/prepare-windows7-asset.test.ts`).

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const lockPath = join(here, 'v86-assets.lock.json');
const CHUNK = 8 * 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

const DEFAULTS = {
  source: process.env.WINDOWS7_IMG ?? join(repoRoot, 'images', 'windows-7-pro-sp1-x86', 'disk.img'),
  ref: 'windows-7-pro-sp1-x86',
  displayName: 'Windows 7 Professionnel SP1 x86',
  architecture: 'i386',
  // Windows 7 (Vista+) needs at least 512 MiB; 1536 MiB is what the guest
  // installed under QEMU requires and v86 accepts (rounded up to 128 KiB).
  memoryMiB: 1536,
  vgaMiB: 16,
  license: 'Local RAW disk from the codebase (not distributed)',
  provenance: 'images/windows-7-pro-sp1-x86/disk.img (local disk served in place)',
  servedName: 'disk.img',
  notes: [
    'Operator-provided 32 GiB RAW disk, served in place (images/windows-7-pro-sp1-x86/disk.img): never copied, git-ignored, never committed nor distributed.',
    'Booted by the BIOS under v86 over HTTP Range (hda.async = true), never as a cdrom.',
  ],
};

const ARCHITECTURES = new Set(['i386', 'x86', 'x86_64', 'arm', 'arm64', 'powerpc', 'm68k']);

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  const flags = {
    skipHash: false,
    check: false,
    json: false,
    resume: false,
    help: false,
    force: false,
    sourceProvided: false,
  };
  let copyTo;
  let outDir;
  let notes;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    // Ergonomic tolerance: a lone `--`, injected by `pnpm <script> -- <opts>`,
    // is skipped like a standard argument parser would (never treated as an
    // unknown option). It can still be the explicit VALUE of an option that
    // takes one (e.g. `--note --`) through `value()`; that case is unchanged.
    if (arg === '--') continue;
    const [name, inline] =
      arg.startsWith('--') && arg.includes('=')
        ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
        : [arg, undefined];
    const value = () => {
      if (inline !== undefined) return inline;
      i += 1;
      if (i >= argv.length) throw new Error(`Option ${name} requires a value.`);
      return argv[i];
    };
    switch (name) {
      case '--source':
        options.source = value();
        flags.sourceProvided = true;
        break;
      case '--ref':
        options.ref = value();
        break;
      case '--display-name':
        options.displayName = value();
        break;
      case '--architecture':
        options.architecture = value();
        break;
      case '--memory-mib':
        options.memoryMiB = Number(value());
        break;
      case '--vga-mib':
        options.vgaMiB = Number(value());
        break;
      case '--license':
        options.license = value();
        break;
      case '--provenance':
        options.provenance = value();
        break;
      case '--served-name':
        options.servedName = value();
        break;
      case '--format':
        options.format = value();
        break;
      case '--note':
        (notes ??= []).push(value());
        break;
      case '--out':
        outDir = value();
        break;
      case '--copy-to':
        copyTo = value();
        break;
      case '--skip-hash':
        flags.skipHash = true;
        break;
      case '--resume':
        flags.resume = true;
        break;
      case '--check':
        flags.check = true;
        break;
      case '--json':
        flags.json = true;
        break;
      case '--force':
        flags.force = true;
        break;
      case '--help':
      case '-h':
        flags.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${name}`);
    }
  }
  // `--note` (repeatable) replaces the default notes; without the option, the
  // Windows 7 notes from `DEFAULTS` are kept (historical behavior unchanged).
  if (notes !== undefined) options.notes = notes;
  return { options, flags, copyTo, outDir };
}

function usage() {
  return `Usage: node scripts/prepare-windows7-asset.mjs [options]

  --source <path>         Source disk image (default:
                          images/windows-7-pro-sp1-x86/disk.img at the repository
                          root, or WINDOWS7_IMG / --source to override it).
                          A relative path is resolved from the current directory;
                          a disk outside the repository records no local path.
  --ref <ref>             Reference (lowercase/hyphens), e.g. windows-7-pro-sp1-x86
  --display-name <name>   Human-readable label
  --architecture <arch>   i386 (default), x86_64, …
  --memory-mib <n>        Recommended guest memory (default 1536)
  --vga-mib <n>           VGA memory (default 16)
  --license <text>        License reminder
  --provenance <text>     Origin of the media
  --served-name <name>    Name served under /images/<ref>/ (default disk.img)
  --format <raw|iso>      Format (default: inferred from the extension)
  --note <text>           Manifest note (repeatable; replaces the default notes)
  --out <dir>             Output directory (default images/<ref>)
  --copy-to <path>        Optional verified copy (never the source, never public/)
  --skip-hash             Do not compute the SHA-256 (documents size + mtime)
  --resume                Reuse the SHA-256 of an existing manifest when size+mtime match
  --check                 Verify the existing manifest without writing anything
                          (follows "source.path", relative to the repository root;
                          requires --source for an external disk)
  --json                  Print the manifest on stdout (logs on stderr)
  --force                 Allow overwriting the existing manifest

Recorded paths: the manifest NEVER contains an absolute path. A disk inside the
repository is recorded relatively (e.g. images/<ref>/disk.img); an external disk
is recorded as "external: true" with no path, and --check requires --source.
`;
}

function log(message) {
  process.stderr.write(`${message}\n`);
}

/**
 * Converts a path to a path RELATIVE to the repository root, with `/` separators
 * (e.g. `images/windows-7-x86/disk.img`). Returns `null` when the file lives
 * outside the repository: an absolute path tied to the operator's machine must
 * never enter the manifest nor `provenance.txt` (it would be useless elsewhere,
 * and the repository must not publish any local path).
 *
 * @param {string} filePath absolute path, or path relative to the cwd
 * @returns {string | null} path relative to the repository root, or null
 */
function toRepoRelativePath(filePath) {
  const absolute = resolve(filePath);
  const rel = relative(repoRoot, absolute);
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/**
 * Resolves a path RECORDED in a manifest. A relative path is always relative to
 * the REPOSITORY ROOT (never to the cwd: Vite and pnpm run from `apps/web` or a
 * subdirectory); an absolute path inherited from an older manifest is used as is.
 *
 * @param {string} recordedPath path recorded in `source.path`
 * @returns {string} absolute path
 */
function resolveRecordedPath(recordedPath) {
  return isAbsolute(recordedPath) ? recordedPath : resolve(repoRoot, recordedPath);
}

/** Rejects any target inside a `public/` directory (Vite bundle). */
function assertNotPublic(path, label) {
  const normalized = resolve(path).toLowerCase().split('\\').join('/');
  if (normalized.includes('/public/')) {
    throw new Error(`Refused: ${label} must never be written into a public/ directory (${path}).`);
  }
}

function detectFormat(sourcePath, explicit) {
  const format = (
    explicit ?? (extname(sourcePath).toLowerCase() === '.iso' ? 'iso' : 'raw')
  ).toLowerCase();
  if (format !== 'raw' && format !== 'iso') {
    throw new Error(`Unknown format "${format}" (expected: raw or iso).`);
  }
  return format;
}

/**
 * Computes the SHA-256 in streaming mode. The file is opened read-only.
 * `onProgress(read, total)` is called for every chunk.
 */
async function sha256File(filePath, { onProgress, timeoutMs } = {}) {
  const hash = createHash('sha256');
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let read = 0;
  try {
    const stream = createReadStream(filePath, { highWaterMark: CHUNK });
    for await (const chunk of stream) {
      if (controller.signal.aborted) throw new Error('Hashing timed out.');
      hash.update(chunk);
      read += chunk.length;
      onProgress?.(read);
    }
    return { sha256: hash.digest('hex'), size: read };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** Verified copy: writes a `.part` file then renames it; hash computed on the stream. */
async function copyAndHash(sourcePath, destination) {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.part`;
  const hash = createHash('sha256');
  const hasher = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(createReadStream(sourcePath), hasher, createWriteStream(temporary));
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  const info = await stat(destination);
  return { sha256: hash.digest('hex'), size: info.size };
}

function engineFromLock(lock) {
  const bin = (name, url) => {
    const entry = lock.assets[name];
    if (!entry) throw new Error(`Incomplete v86 lock: "${name}" is missing.`);
    return { url, size: entry.size, sha256: entry.sha256 };
  };
  return {
    id: 'v86',
    wasm: bin('v86.wasm', '/v86/v86.wasm'),
    bios: {
      seabios: bin('seabios.bin', '/v86/seabios.bin'),
      vgabios: bin('vgabios.bin', '/v86/vgabios.bin'),
    },
  };
}

async function fileExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readExistingManifest(outDir) {
  const manifestPath = join(outDir, 'manifest.json');
  if (!(await fileExists(manifestPath))) return null;
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  const { options, flags, copyTo, outDir } = parseArgs(process.argv.slice(2));
  if (flags.help) {
    process.stdout.write(usage());
    return 0;
  }

  if (!ARCHITECTURES.has(options.architecture)) {
    throw new Error(`Invalid architecture "${options.architecture}".`);
  }
  if (!Number.isInteger(options.memoryMiB) || options.memoryMiB <= 0) {
    throw new Error('--memory-mib must be a positive integer.');
  }
  if (!Number.isInteger(options.vgaMiB) || options.vgaMiB <= 0) {
    throw new Error('--vga-mib must be a positive integer.');
  }
  if (!/^[a-z0-9-]+$/.test(options.ref)) {
    throw new Error(`Invalid reference "${options.ref}" (lowercase letters, digits, hyphens).`);
  }

  const outputDir = resolve(outDir ?? join(repoRoot, 'images', options.ref));
  const manifestPath = join(outputDir, 'manifest.json');

  // On a check without an explicit --source, follow the path recorded in the
  // manifest (RELATIVE to the repository root, or absolute when inherited from
  // an older manifest). A manifest created from an EXTERNAL disk records no
  // path: --source must then be provided explicitly.
  let sourcePath = resolve(options.source);
  if (flags.check && !flags.sourceProvided) {
    const recorded = await readExistingManifest(outputDir);
    const recordedPath = recorded?.source?.path;
    if (typeof recordedPath === 'string' && recordedPath.length > 0) {
      sourcePath = resolveRecordedPath(recordedPath);
    } else if (recorded?.source?.external === true) {
      throw new Error(
        'This manifest was generated from a disk OUTSIDE the repository: no local path is ' +
          'recorded (it must never be published). Re-run the check with --source:\n' +
          '  node scripts/prepare-windows7-asset.mjs --check --source "<disk>"',
      );
    }
  }

  await access(sourcePath, fsConstants.R_OK).catch(() => {
    throw new Error(`Source not found or unreadable: ${sourcePath}`);
  });
  const sourceInfo = await stat(sourcePath);
  if (!sourceInfo.isFile()) throw new Error(`The source is not a file: ${sourcePath}`);
  if (!Number.isInteger(sourceInfo.size) || sourceInfo.size <= 0) {
    throw new Error(`Invalid source size: ${sourceInfo.size}`);
  }
  const format = detectFormat(sourcePath, options.format);

  // ---- Check mode --------------------------------------------------------
  if (flags.check) {
    const existing = await readExistingManifest(outputDir);
    if (!existing) throw new Error(`No manifest to check in ${outputDir}.`);
    const problems = [];
    if (existing.source?.size !== sourceInfo.size) {
      problems.push(`source size: ${sourceInfo.size} != manifest ${existing.source?.size}`);
    }
    if (Math.trunc(existing.source?.mtimeMs ?? -1) !== Math.trunc(sourceInfo.mtimeMs)) {
      problems.push(
        `source mtime: ${Math.trunc(sourceInfo.mtimeMs)} != manifest ${Math.trunc(existing.source?.mtimeMs ?? -1)}`,
      );
    }
    if (existing.disk?.size !== sourceInfo.size) {
      problems.push(`disk size: ${sourceInfo.size} != manifest ${existing.disk?.size}`);
    }
    if (existing.disk?.sha256 && !flags.skipHash) {
      log('→ Verifying SHA-256 (streaming)…');
      const result = await sha256File(sourcePath, {
        onProgress: makeProgress(sourceInfo.size),
        timeoutMs: 30 * 60 * 1000,
      });
      if (result.sha256 !== existing.disk.sha256) {
        problems.push(`SHA-256: ${result.sha256} != manifest ${existing.disk.sha256}`);
      }
      log(`  sha256=${result.sha256}`);
    } else if (existing.disk?.sha256 === undefined) {
      log('ℹ Manifest without SHA-256 (documented by size + mtime).');
    }
    if (problems.length > 0) {
      for (const problem of problems) log(`✗ ${problem}`);
      return 1;
    }
    log(`✓ Manifest matches: ${manifestPath}`);
    return 0;
  }

  // ---- Generation mode ---------------------------------------------------
  assertNotPublic(outputDir, 'the output directory');
  if (copyTo !== undefined) assertNotPublic(copyTo, 'the disk copy');

  const sourceReal = resolve(sourcePath).toLowerCase();
  if (copyTo !== undefined && resolve(copyTo).toLowerCase() === sourceReal) {
    throw new Error('Refusing to write onto the source: --copy-to cannot be the source file.');
  }

  const priorManifest = await readExistingManifest(outputDir);
  if (priorManifest && !flags.force) {
    throw new Error(
      `A manifest already exists (${manifestPath}). Use --check to verify it or --force to regenerate it.`,
    );
  }

  const progress = makeProgress(sourceInfo.size);
  let sha256;
  let hashSource = sourcePath;

  if (flags.skipHash) {
    log('ℹ --skip-hash: SHA-256 not computed. Documented method: `sha256sum` on the source file.');
  } else {
    const reusable =
      flags.resume &&
      priorManifest?.disk?.sha256 &&
      priorManifest?.source?.size === sourceInfo.size &&
      Math.trunc(priorManifest?.source?.mtimeMs) === Math.trunc(sourceInfo.mtimeMs);
    if (reusable) {
      sha256 = priorManifest.disk.sha256;
      log(`✓ SHA-256 reused from the existing manifest: ${sha256}`);
    } else {
      log(`→ Computing SHA-256 in streaming mode from ${sourcePath}…`);
      const result = await sha256File(sourcePath, {
        onProgress: progress,
        timeoutMs: 30 * 60 * 1000,
      });
      sha256 = result.sha256;
      if (result.size !== sourceInfo.size) {
        throw new Error(
          `The read returned ${result.size} bytes while stat reports ${sourceInfo.size}.`,
        );
      }
      log(`\n  sha256=${sha256}`);
    }
  }

  // Optional verified copy (never required for v86: the RAW disk is read directly).
  if (copyTo !== undefined) {
    if (sha256 === undefined) {
      throw new Error('--copy-to requires the SHA-256 (drop --skip-hash) to verify the copy.');
    }
    const destination = resolve(copyTo);
    log(`→ Verified copy to ${destination}…`);
    const copied = await copyAndHash(sourcePath, destination);
    if (copied.size !== sourceInfo.size || copied.sha256 !== sha256) {
      await rm(destination, { force: true });
      throw new Error(
        `Invalid copy: ${copied.size} bytes / sha256=${copied.sha256}; original unchanged.`,
      );
    }
    log(`✓ Verified copy (${copied.size} bytes, identical sha256).`);
    hashSource = destination;
  }

  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  const diskUrl = `/images/${options.ref}/${options.servedName}`;
  const diskMtimeMs = Math.trunc(sourceInfo.mtimeMs);

  // No absolute path is ever written: a path relative to the repository root when
  // the disk lives there, otherwise a plain "external" marker (size + mtime are
  // enough to re-detect the file without publishing the operator's tree).
  const sourceRelative = toRepoRelativePath(hashSource);
  const source =
    sourceRelative === null
      ? { external: true, size: sourceInfo.size, mtimeMs: diskMtimeMs }
      : { path: sourceRelative, size: sourceInfo.size, mtimeMs: diskMtimeMs };

  const manifest = {
    version: 1,
    ref: options.ref,
    displayName: options.displayName,
    architecture: options.architecture,
    memoryMiB: options.memoryMiB,
    vgaMemoryMiB: options.vgaMiB,
    license: options.license,
    provenance: options.provenance,
    source,
    disk: {
      fileName: options.servedName,
      format,
      url: diskUrl,
      size: sourceInfo.size,
      mtimeMs: diskMtimeMs,
      ...(sha256 === undefined ? {} : { sha256 }),
    },
    engine: engineFromLock(lock),
    boot: { mode: 'disk-boot', url: diskUrl, async: true, size: sourceInfo.size },
    notes: options.notes,
  };

  await mkdir(outputDir, { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(
    join(outputDir, 'provenance.txt'),
    [
      `ref            : ${options.ref}`,
      // Path relative to the repository only: never publish an absolute path.
      `source         : ${sourceRelative ?? '(external disk — no path recorded)'}`,
      `size           : ${sourceInfo.size} bytes (${(sourceInfo.size / GIB).toFixed(3)} GiB)`,
      `mtime (ms)     : ${diskMtimeMs}`,
      `format         : ${format}`,
      `sha256         : ${sha256 ?? '(not computed — see method)'}`,
      `generated at   : ${new Date().toISOString()}`,
      `tool           : scripts/prepare-windows7-asset.mjs`,
      '',
      'Local media, not distributed: never commit it or copy it into public/.',
      '',
    ].join('\n'),
    'utf8',
  );

  log(`✓ Manifest written: ${manifestPath}`);
  if (sha256) log(`  sha256=${sha256}`);
  log(`  size=${sourceInfo.size} bytes (${(sourceInfo.size / GIB).toFixed(3)} GiB)`);
  log(`  disk served under ${diskUrl}`);

  if (flags.json) process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  return 0;
}

function makeProgress(total) {
  let nextMark = GIB;
  return (read) => {
    if (read >= nextMark || read === total) {
      const percent = total > 0 ? ((read / total) * 100).toFixed(1) : '?';
      log(`  ${(read / GIB).toFixed(2)} GiB / ${(total / GIB).toFixed(2)} GiB (${percent} %)`);
      nextMark += GIB;
    }
  };
}

main()
  .then((code) => {
    if (code !== 0) process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`✗ ${error.message}\n`);
    process.exitCode = 1;
  });
