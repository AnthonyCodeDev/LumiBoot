import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import {
  DEFAULT_OUT,
  assertDmgSource,
  describeMagic,
  detectHfsPlus,
  detectUdif,
  isGzipMagic,
  parseArgs,
  resolveSevenZip,
  sevenZipCandidates,
} from '../scripts/extract-macos-lion-media.mjs';

// Unit tests of the pure helpers of extract-macos-lion-media.mjs, plus a few CLI
// checks of --check on synthetic trees. No Apple media, no 7-Zip, no child 7-Zip
// process: the real extraction needs the operator's InstallMacOSX.dmg.
//
// Measured on the real Lion installer (2026-11-04): a UDIF image ends with a
// 512-byte trailer that STARTS with `koly`; the last four bytes of the file are
// `00 00 00 00`, so a "last four bytes are koly" test is wrong.

const repoRoot = process.cwd();
const SCRIPT = join(repoRoot, 'scripts', 'extract-macos-lion-media.mjs');
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'lumiboot-macos-lion-'));

function run(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repoRoot, encoding: 'utf8' });
}

/** A truncated but structurally correct UDIF: payload, then a 512-byte `koly` trailer. */
function fakeUdif(payloadLength = 2048) {
  const bytes = Buffer.alloc(payloadLength + 512, 0);
  bytes.write('koly', payloadLength, 'latin1');
  return { bytes, trailer: bytes.subarray(payloadLength) };
}

/** Writes a small fake InstallESD.dmg and returns its bytes. */
function writeFakeEsd(filePath: string) {
  const { bytes } = fakeUdif(1024);
  writeFileSync(filePath, bytes);
  return bytes;
}

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe('parseArgs', () => {
  it('defaults to no source and the Git-ignored build directory', () => {
    const { options, flags } = parseArgs([]);
    expect(options.source).toBeUndefined();
    expect(options.out).toBe(DEFAULT_OUT);
    expect(options.out).toBe('images/macos-lion-x64/build');
    expect(flags).toEqual({ force: false, check: false, json: false, help: false });
  });

  it('reads --source and --out in both syntaxes', () => {
    const spaced = parseArgs([
      '--source',
      'D:\\Apple\\InstallMacOSX.dmg',
      '--out',
      'D:\\tmp\\lion',
    ]);
    expect(spaced.options.source).toBe('D:\\Apple\\InstallMacOSX.dmg');
    expect(spaced.options.out).toBe('D:\\tmp\\lion');

    const inline = parseArgs(['--source=/media/lion/InstallMacOSX.dmg', '--out=build/lion']);
    expect(inline.options.source).toBe('/media/lion/InstallMacOSX.dmg');
    expect(inline.options.out).toBe('build/lion');
  });

  it('collects the boolean flags and tolerates a lone "--"', () => {
    const { options, flags } = parseArgs(['--', '--check', '--json', '--force']);
    expect(flags).toEqual({ force: true, check: true, json: true, help: false });
    expect(options.source).toBeUndefined();
  });

  it('recognises -h and --help', () => {
    expect(parseArgs(['-h']).flags.help).toBe(true);
    expect(parseArgs(['--help']).flags.help).toBe(true);
  });

  it('rejects an unknown option and a missing value', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown option/);
    expect(() => parseArgs(['--source'])).toThrow(/requires a value/);
  });
});

describe('assertDmgSource', () => {
  it('accepts a .dmg, case-insensitively', () => {
    expect(assertDmgSource('D:\\Apple\\InstallMacOSX.dmg')).toBe('D:\\Apple\\InstallMacOSX.dmg');
    expect(assertDmgSource('/media/lion/instalL.DMG')).toBe('/media/lion/instalL.DMG');
  });

  it('refuses a missing source', () => {
    expect(() => assertDmgSource(undefined)).toThrow(/Missing source/);
    expect(() => assertDmgSource('')).toThrow(/Missing source/);
    expect(() => assertDmgSource('   ')).toThrow(/Missing source/);
  });

  it('refuses anything that is not a .dmg', () => {
    expect(() => assertDmgSource('D:\\Apple\\InstallMacOSX.pkg')).toThrow(/not a \.dmg/);
    expect(() => assertDmgSource('D:\\Apple\\InstallESD.iso')).toThrow(/not a \.dmg/);
    expect(() => assertDmgSource('InstallESD.dmg.iso')).toThrow(/not a \.dmg/);
    expect(() => assertDmgSource('InstallMacOSX')).toThrow(/not a \.dmg/);
  });
});

describe('sevenZipCandidates', () => {
  it('tries PATH first, then the two Windows directories, then $SEVEN_ZIP', () => {
    const candidates = sevenZipCandidates({
      pathValue: 'C:\\Tools;C:\\Windows\\System32',
      env: { SEVEN_ZIP: 'D:\\7z\\7z.exe' },
      platform: 'win32',
    });
    expect(candidates.slice(0, 2)).toEqual(['C:\\Tools\\7z.exe', 'C:\\Windows\\System32\\7z.exe']);
    expect(candidates.slice(2, 4)).toEqual([
      'C:\\Program Files\\7-Zip\\7z.exe',
      'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    ]);
    expect(candidates[4]).toBe('D:\\7z\\7z.exe');
    expect(candidates).toHaveLength(5);
  });

  it('uses the bare 7z name off Windows and ignores empty PATH entries', () => {
    const candidates = sevenZipCandidates({
      pathValue: '/usr/bin::/usr/local/bin',
      env: {},
      platform: 'linux',
    });
    expect(candidates).toContain('/usr/bin/7z');
    expect(candidates).toContain('/usr/local/bin/7z');
    expect(candidates).not.toContain('/7z');
    expect(candidates).not.toContain('/usr/bin/7z.exe');
    expect(candidates.some((candidate) => candidate.includes('Program Files'))).toBe(false);
  });

  it('is independent of the host OS: a win32 target always splits on ";" and joins with "\\"', () => {
    // Regression: `delimiter` and `join` from `node:path` follow the HOST. On Linux the
    // input below was split on ':' and joined with '/', yielding 'C/7z.exe'.
    const candidates = sevenZipCandidates({
      pathValue: 'C:\\Tools;C:\\Windows\\System32',
      env: {},
      platform: 'win32',
    });
    expect(candidates.slice(0, 2)).toEqual(['C:\\Tools\\7z.exe', 'C:\\Windows\\System32\\7z.exe']);
    expect(candidates).not.toContain('C/7z.exe');
    // The invariant itself: win32 is pure and never follows the host.
    expect(win32.delimiter).toBe(';');
    expect(win32.join('C:\\Tools', '7z.exe')).toBe('C:\\Tools\\7z.exe');
  });

  it('adds no $SEVEN_ZIP candidate when the variable is empty or absent', () => {
    expect(
      sevenZipCandidates({ pathValue: '', env: { SEVEN_ZIP: '' }, platform: 'win32' }),
    ).toHaveLength(2);
    expect(sevenZipCandidates({ pathValue: '', env: {}, platform: 'win32' })).toHaveLength(2);
  });
});

describe('resolveSevenZip', () => {
  it('returns the first existing candidate in order', () => {
    const candidates = ['C:\\missing\\7z.exe', 'C:\\Tools\\7z.exe', 'C:\\7-Zip\\7z.exe'];
    const resolved = resolveSevenZip(candidates, (candidate) => candidate.includes('Tools'));
    expect(resolved).toBe('C:\\Tools\\7z.exe');
  });

  it('falls back to $SEVEN_ZIP when nothing earlier exists', () => {
    const candidates = ['C:\\missing\\7z.exe', 'D:\\7z\\7z.exe'];
    const resolved = resolveSevenZip(candidates, (candidate) => candidate === 'D:\\7z\\7z.exe');
    expect(resolved).toBe('D:\\7z\\7z.exe');
  });

  it('de-duplicates case-insensitively only for a win32 target', () => {
    const seen: string[] = [];
    const exists = (candidate: string) => {
      seen.push(candidate);
      return false;
    };

    resolveSevenZip(['C:\\Tools\\7z.exe', 'c:\\tools\\7Z.EXE'], exists, 'win32');
    expect(seen).toEqual(['C:\\Tools\\7z.exe']);

    seen.length = 0;
    resolveSevenZip(['/usr/bin/7z', '/USR/BIN/7z'], exists, 'linux');
    expect(seen).toHaveLength(2);

    // Existing two-argument calls keep following the host.
    seen.length = 0;
    resolveSevenZip(['C:\\Tools\\7z.exe', 'c:\\tools\\7Z.EXE'], exists);
    expect(seen).toHaveLength(process.platform === 'win32' ? 1 : 2);
  });

  it('returns undefined when nothing exists, and tolerates a throwing predicate', () => {
    expect(resolveSevenZip(['C:\\missing\\7z.exe'], () => false)).toBeUndefined();
    expect(resolveSevenZip([], () => true)).toBeUndefined();
    expect(resolveSevenZip(undefined, () => true)).toBeUndefined();
    expect(
      resolveSevenZip(['C:\\bad\\7z.exe', 'C:\\good\\7z.exe'], (candidate) => {
        if (candidate.includes('bad')) throw new Error('EPERM');
        return true;
      }),
    ).toBe('C:\\good\\7z.exe');
  });
});

describe('detectUdif', () => {
  it('accepts a 512-byte trailer that starts with "koly" and ends with zeros', () => {
    const { bytes, trailer } = fakeUdif();
    expect(trailer).toHaveLength(512);
    expect(trailer.subarray(0, 4).toString('latin1')).toBe('koly');
    expect(trailer.subarray(508).toString('hex')).toBe('00000000');
    // The 4 last bytes of the whole file are zeros, not `koly`.
    expect(bytes.subarray(bytes.length - 4).toString('hex')).toBe('00000000');
    expect(detectUdif(trailer)).toBe(true);
  });

  it('rejects a file that merely ends with "koly" (the old, wrong assumption)', () => {
    const bytes = Buffer.from('payload-and-then-koly', 'latin1');
    expect(bytes.subarray(bytes.length - 4).toString('latin1')).toBe('koly');
    // As a trailer block, this buffer starts with 'payl', so it is not a UDIF trailer.
    expect(detectUdif(bytes)).toBe(false);
  });

  it('rejects a zero-filled trailer and buffers too short to carry a magic', () => {
    expect(detectUdif(Buffer.alloc(512, 0))).toBe(false);
    expect(detectUdif(Buffer.from('kol'))).toBe(false);
    expect(detectUdif(Buffer.alloc(0))).toBe(false);
    expect(detectUdif(undefined)).toBe(false);
    expect(detectUdif(null)).toBe(false);
  });
});

describe('isGzipMagic', () => {
  it('accepts a real gzip header', () => {
    expect(isGzipMagic(Buffer.from([0x1f, 0x8b, 0x08, 0x00]))).toBe(true);
  });

  it('rejects the plain cpio the real 7-Zip extraction produces', () => {
    // The Lion `Payload` extracted by 7-Zip starts with the ASCII cpio magic "070707".
    expect(Buffer.from('07070700', 'latin1').subarray(0, 2).toString('hex')).toBe('3037');
    expect(isGzipMagic(Buffer.from('07070700', 'latin1'))).toBe(false);
    expect(isGzipMagic(Buffer.alloc(2, 0))).toBe(false);
    expect(isGzipMagic(Buffer.from([0x1f]))).toBe(false);
    expect(isGzipMagic(undefined)).toBe(false);
  });
});

describe('detectHfsPlus', () => {
  it('reads "H+" at offset 1024 (HFS+)', () => {
    const bytes = Buffer.alloc(2048, 0);
    bytes.write('H+', 1024, 'latin1');
    expect(detectHfsPlus(bytes)).toBe('H+');
  });

  it('reads "HX" at offset 1024 (HFSX)', () => {
    const bytes = Buffer.alloc(2048, 0);
    bytes.write('HX', 1024, 'latin1');
    expect(detectHfsPlus(bytes)).toBe('HX');
  });

  it('returns null for another signature or a short buffer', () => {
    const bytes = Buffer.alloc(2048, 0);
    bytes.write('BD', 1024, 'latin1');
    expect(detectHfsPlus(bytes)).toBeNull();
    expect(detectHfsPlus(Buffer.alloc(512, 0))).toBeNull();
    expect(detectHfsPlus(undefined)).toBeNull();
  });
});

describe('describeMagic', () => {
  it('classifies a real-shaped UDIF from its 512-byte trailer', () => {
    const { bytes, trailer } = fakeUdif();
    const summary = describeMagic({ head: bytes, trailer });
    expect(summary.udif).toBe(true);
    expect(summary.kind).toBe('udif');
    expect(summary.trailerMagic).toBe('koly');
    expect(summary.trailerBytes).toBe(512);
    expect(summary.hfsPlusSignature).toBeNull();
    expect(summary.headBytes).toBe(bytes.length);
  });

  it('classifies a raw HFS+ volume by its header when no UDIF trailer is present', () => {
    const head = Buffer.alloc(2048, 0);
    head.write('H+', 1024, 'latin1');
    const summary = describeMagic({ head, trailer: Buffer.from('tail', 'latin1') });
    expect(summary.udif).toBe(false);
    expect(summary.kind).toBe('hfs+');
    expect(summary.hfsPlusSignature).toBe('H+');
    expect(summary.trailerMagic).toBe('tail');
  });

  it('shows the measured bytes instead of guessing when the input is ambiguous', () => {
    const head = Buffer.alloc(64, 0);
    const summary = describeMagic({ head, trailer: Buffer.from([0x00, 0x01, 0x00, 0x02]) });
    expect(summary.kind).toBe('unknown');
    expect(summary.udif).toBe(false);
    expect(summary.trailerMagic).toBe('0x00010002');
    expect(summary.hfsPlusSignature).toBeNull();
    expect(summary.headBytes).toBe(64);
  });

  it('reports the missing probes on an empty input', () => {
    const summary = describeMagic({});
    expect(summary.kind).toBe('unknown');
    expect(summary.trailerMagic).toBeNull();
    expect(summary.headBytes).toBe(0);
    expect(summary.trailerBytes).toBe(0);
  });
});

describe('--check', () => {
  it('accepts the layout the extractor produces: InstallESD.dmg as a direct xar member', () => {
    const outDir = join(TMP_ROOT, 'xar-member');
    mkdirSync(join(outDir, 'dmg', 'Install Mac OS X'), { recursive: true });
    mkdirSync(join(outDir, 'pkg', 'InstallMacOSX.pkg'), { recursive: true });
    writeFileSync(join(outDir, 'dmg', 'Install Mac OS X', 'InstallMacOSX.pkg'), 'xar');
    const esd = writeFakeEsd(join(outDir, 'pkg', 'InstallMacOSX.pkg', 'InstallESD.dmg'));

    const result = run(['--check', '--out', outDir, '--json']);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('InstallESD.dmg');
    expect(result.stderr).toContain('koly');
    // The source DMG is never produced by the extractor: it must not be reported missing.
    expect(result.stderr).not.toContain('✗');
    expect(result.stderr).not.toContain('InstallMacOSX.dmg');

    const summary = JSON.parse(result.stdout);
    expect(summary.installEsd.path).toContain('InstallMacOSX.pkg');
    expect(summary.installEsd.size).toBe(esd.length);
    expect(summary.installEsd.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(summary.installEsd.magic.udif).toBe(true);
  });

  it('accepts the older layout where InstallESD.dmg only exists under payload/', () => {
    const outDir = join(TMP_ROOT, 'payload-layout');
    mkdirSync(join(outDir, 'pkg', 'InstallMacOSX.pkg'), { recursive: true });
    mkdirSync(join(outDir, 'payload'), { recursive: true });
    writeFileSync(join(outDir, 'pkg', 'InstallMacOSX.pkg', 'Bom'), 'bom');
    writeFakeEsd(join(outDir, 'payload', 'InstallESD.dmg'));

    const result = run(['--check', '--out', outDir]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('payload');
    expect(result.stderr).not.toContain('✗');
  });

  it('fails only when InstallESD.dmg is missing', () => {
    const outDir = join(TMP_ROOT, 'incomplete');
    mkdirSync(join(outDir, 'pkg', 'InstallMacOSX.pkg'), { recursive: true });
    writeFileSync(join(outDir, 'pkg', 'InstallMacOSX.pkg', 'Bom'), 'bom');

    const result = run(['--check', '--out', outDir]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('✗');
    expect(result.stderr).toContain('InstallESD.dmg is missing');
  });

  it('mentions a source copy when one is present, without requiring it', () => {
    const outDir = join(TMP_ROOT, 'with-source');
    mkdirSync(join(outDir, 'pkg'), { recursive: true });
    const { bytes } = fakeUdif(512);
    writeFileSync(join(outDir, 'InstallMacOSX.dmg'), bytes);
    writeFakeEsd(join(outDir, 'pkg', 'InstallESD.dmg'));

    const result = run(['--check', '--out', outDir]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('Source copy');
    expect(result.stderr).not.toContain('✗');
  });
});
