import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLocalDiskManifest } from '../packages/vm-assets/src/local-disk';

// Integration test of the prepare-macos-lion-asset.mjs wrapper (delegation + RAW/ESP guards).
// The extractor of the Apple DMG has its own file: tests/prepare-macos-lion-asset.test.ts.

const repoRoot = process.cwd();
const SCRIPT = join(repoRoot, 'scripts', 'prepare-macos-lion-asset.mjs');

let tempDir = '';
let source = '';
let sourceBytes: Buffer;
let esp = '';
let espBytes: Buffer;
// A disk inside the repository: only then does the manifest record `source.path`,
// which is what `--check` follows when `--source` is omitted.
let repoDir = '';

function run(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync('node', [SCRIPT, ...args], { cwd: repoRoot, encoding: 'utf8', env });
}

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'lumiboot-macoslion-'));
  source = join(tempDir, 'disk.img');
  sourceBytes = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < sourceBytes.length; i += 1) sourceBytes[i] = (i * 13) % 251;
  writeFileSync(source, sourceBytes);

  // A stand-in OpenCore ESP: small, hashed in full by the generator.
  esp = join(tempDir, 'esp.img');
  espBytes = Buffer.alloc(4096);
  for (let i = 0; i < espBytes.length; i += 1) espBytes[i] = (i * 5) % 247;
  writeFileSync(esp, espBytes);

  // `.tmp/` is Git-ignored: a throwaway repository-relative disk for the --check path.
  mkdirSync(join(repoRoot, '.tmp'), { recursive: true });
  repoDir = mkdtempSync(join(repoRoot, '.tmp', 'macoslion-'));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

describe('prepare-macos-lion-asset.mjs', () => {
  it('delegates to the generator with the macOS Lion x64 values (v64 + ESP)', () => {
    const outDir = join(tempDir, 'out');
    const result = run([
      '--source',
      source,
      '--esp',
      esp,
      '--out',
      outDir,
      '--skip-hash',
      '--json',
    ]);
    expect(result.status).toBe(0);
    const manifest = parseLocalDiskManifest(JSON.parse(result.stdout));

    // The wrapper injects every value, so `--source`/`--esp`/`--out` are all the operator passes.
    expect(manifest.ref).toBe('macos-lion-x64');
    expect(manifest.displayName).toBe('macOS Lion');
    expect(manifest.architecture).toBe('x86_64');
    expect(manifest.memoryMiB).toBe(2048);
    expect(manifest.vgaMemoryMiB).toBe(32);
    expect(manifest.engine).toEqual({ id: 'v64' });
    expect(manifest.disk.format).toBe('raw');
    expect(manifest.disk.size).toBe(sourceBytes.length);
    expect(manifest.disk.url).toBe('/images/macos-lion-x64/disk.img');
    // `--skip-hash` only skips the disk: the small ESP is always hashed.
    expect(manifest.disk.sha256).toBeUndefined();
    expect(manifest.esp).toEqual({
      fileName: 'esp.img',
      url: '/images/macos-lion-x64/esp.img',
      size: espBytes.length,
    });
    expect(manifest.boot).toEqual({
      mode: 'disk-boot',
      url: '/images/macos-lion-x64/disk.img',
      async: true,
      size: sourceBytes.length,
    });
    // The macOS Lion notes and licence replace the generator's Windows 7 defaults.
    expect(manifest.license).toContain('Apple licensing');
    expect(manifest.provenance).toContain('OpenCore');
    expect(manifest.notes?.join(' ')).toContain('OpenCore');
    expect(manifest.notes?.join(' ')).not.toContain('Windows');

    // Both files are written next to each other, with no absolute path in the manifest.
    expect(existsSync(join(outDir, 'manifest.json'))).toBe(true);
    const provenance = readFileSync(join(outDir, 'provenance.txt'), 'utf8');
    expect(provenance).toContain('ref            : macos-lion-x64');
    expect(provenance).toContain('drive layout   : ESP = hda (SATA 0), system disk = hdb');
    expect(readFileSync(join(outDir, 'manifest.json'), 'utf8')).not.toContain(tempDir);
  });

  it('refuses a source that is neither .img nor .raw, and writes no manifest', () => {
    for (const [name, expected] of [
      ['disk.iso', 'ISO'],
      ['disk.dmg', 'DMG'],
      ['disk.qcow2', 'QCOW2'],
      ['disk.vmdk', 'VMDK'],
      ['disk.bin', '.img or .raw'],
    ]) {
      const path = join(tempDir, name);
      writeFileSync(path, sourceBytes);
      const outDir = join(tempDir, `out-${name.replace('.', '-')}`);
      const result = run(['--source', path, '--esp', esp, '--out', outDir, '--json']);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(expected);
      expect(existsSync(join(outDir, 'manifest.json'))).toBe(false);
    }
  });

  it('fails readably when the default disk is missing (no --source)', () => {
    const missing = join(tempDir, 'absent.img');
    const outDir = join(tempDir, 'out-missing-default');
    const result = run(['--esp', esp, '--out', outDir, '--json'], {
      ...process.env,
      MACOS_LION_IMG: missing,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('No local "macos-lion-x64" disk image found');
    expect(result.stderr).toContain(missing);
    // Actionable: it says where the operator's image goes.
    expect(result.stderr).toContain('images/macos-lion-x64/disk.img');
    expect(existsSync(join(outDir, 'manifest.json'))).toBe(false);
  });

  it('fails readably when the explicit --source does not exist', () => {
    const missing = join(tempDir, 'absent-explicit.img');
    const outDir = join(tempDir, 'out-missing-explicit');
    const result = run(['--source', missing, '--esp', esp, '--out', outDir, '--json']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(missing);
    expect(existsSync(join(outDir, 'manifest.json'))).toBe(false);
  });

  it('fails readably when the default ESP is missing (no --esp)', () => {
    const outDir = join(tempDir, 'out-missing-esp');
    const missing = join(tempDir, 'absent-esp.img');
    const result = run(['--source', source, '--out', outDir], {
      ...process.env,
      MACOS_LION_ESP: missing,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('No OpenCore ESP image found');
    expect(result.stderr).toContain(missing);
    expect(result.stderr).toContain('images/macos-lion-x64/esp.img');
    expect(existsSync(join(outDir, 'manifest.json'))).toBe(false);
  });

  it('checks the existing manifest without --source or --esp', () => {
    const disk = join(repoDir, 'disk.img');
    const repoEsp = join(repoDir, 'esp.img');
    writeFileSync(disk, sourceBytes);
    writeFileSync(repoEsp, espBytes);
    const outDir = join(repoDir, 'out');
    expect(run(['--source', disk, '--esp', repoEsp, '--out', outDir]).status).toBe(0);
    // Neither the disk nor the ESP is passed: --check follows the recorded/adjacent files.
    const result = run(['--out', outDir, '--check'], { ...process.env, MACOS_LION_ESP: '' });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('Manifest matches');
    expect(result.stderr).toContain('ESP sha256=');
  });

  it('tolerates a lone "--" (injected by pnpm) and keeps the v64 defaults', () => {
    const outDir = join(tempDir, 'out-dashdash');
    const result = run([
      '--source',
      source,
      '--esp',
      esp,
      '--out',
      outDir,
      '--',
      '--skip-hash',
      '--json',
    ]);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('Unknown option');
    const manifest = parseLocalDiskManifest(JSON.parse(result.stdout));
    expect(manifest.ref).toBe('macos-lion-x64');
    expect(manifest.engine.id).toBe('v64');
    expect(manifest.esp?.url).toBe('/images/macos-lion-x64/esp.img');
  });

  it('documents exactly two commands in its own help', () => {
    const output = execFileSync('node', [SCRIPT, '--help'], { cwd: repoRoot, encoding: 'utf8' });
    const commands = output.split('\n').filter((line) => line.trim().startsWith('pnpm '));
    expect(commands).toEqual([
      '  pnpm assets:macoslion:prepare -- --source "<path>/disk.img"',
      '  pnpm assets:macoslion:prepare -- --force',
    ]);
    expect(output).toContain('--esp');
    expect(output).toContain('--check');
  });
});
