import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLocalDiskManifest } from '../packages/vm-assets/src/local-disk';

// Integration test of the real prepare-windows7-asset.mjs pipeline (temp image).

const repoRoot = process.cwd();
const SCRIPT = join(repoRoot, 'scripts', 'prepare-windows7-asset.mjs');

let tempDir = '';
let source = '';
let outDir = '';
let sourceBytes: Buffer;
let sourceHash = '';
let espSource = '';
let espBytes: Buffer;
let espHash = '';

function run(args: string[]) {
  return spawnSync('node', [SCRIPT, ...args], { cwd: repoRoot, encoding: 'utf8' });
}

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'lumiboot-prep-'));
  source = join(tempDir, 'win7.img');
  outDir = join(tempDir, 'out');
  sourceBytes = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < sourceBytes.length; i += 1) sourceBytes[i] = (i * 7) % 251;
  writeFileSync(source, sourceBytes);
  sourceHash = createHash('sha256').update(sourceBytes).digest('hex');

  // Stand-in EFI System Partition of a two-media boot (outside the output dir,
  // so `--esp` has to copy it next to the manifest).
  espSource = join(tempDir, 'esp.img');
  espBytes = Buffer.alloc(64 * 1024);
  for (let i = 0; i < espBytes.length; i += 1) espBytes[i] = (i * 13) % 247;
  writeFileSync(espSource, espBytes);
  espHash = createHash('sha256').update(espBytes).digest('hex');
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('prepare-windows7-asset.mjs', () => {
  it('generates a valid manifest (with the real SHA-256)', () => {
    const result = run([
      '--source',
      source,
      '--out',
      outDir,
      '--ref',
      'windows-7-pro-sp1-x86',
      '--json',
    ]);
    expect(result.status).toBe(0);
    const manifest = parseLocalDiskManifest(JSON.parse(result.stdout));
    expect(manifest.ref).toBe('windows-7-pro-sp1-x86');
    expect(manifest.disk.size).toBe(sourceBytes.length);
    expect(manifest.disk.sha256).toBe(sourceHash);
    expect(manifest.boot).toEqual({
      mode: 'disk-boot',
      url: '/images/windows-7-pro-sp1-x86/disk.img',
      async: true,
      size: sourceBytes.length,
    });
    expect(manifest.engine.wasm.sha256).toHaveLength(64);
    // Default behaviour: no ESP field at all, so the manifest is unchanged.
    expect(manifest).not.toHaveProperty('esp');
    expect('esp' in manifest).toBe(false);
  });

  it('neither overwrites nor modifies the source file', () => {
    const before = statSync(source);
    const result = run(['--source', source, '--out', outDir, '--force', '--json']);
    expect(result.status).toBe(0);
    const after = statSync(source);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(createHash('sha256').update(readFileSync(source)).digest('hex')).toBe(sourceHash);
  });

  it('refuses to overwrite an existing manifest without --force', () => {
    const result = run(['--source', source, '--out', outDir, '--skip-hash']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--check');
  });

  it('supports --skip-hash (size + mtime documented, no SHA)', () => {
    const out = join(tempDir, 'out-skip');
    const result = run(['--source', source, '--out', out, '--skip-hash', '--json']);
    expect(result.status).toBe(0);
    const manifest = parseLocalDiskManifest(JSON.parse(result.stdout));
    expect(manifest.disk.sha256).toBeUndefined();
    expect(manifest.disk.size).toBe(sourceBytes.length);
  });

  it('verifies an existing manifest with --check', () => {
    const result = run(['--source', source, '--out', outDir, '--check']);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('Manifest matches');
  });

  it('detects a modified source with --check', () => {
    const out = join(tempDir, 'out-check');
    run(['--source', source, '--out', out, '--skip-hash']);
    // Modifies the source AFTER generation: the size differs -> expected failure.
    const modified = join(tempDir, 'modified.img');
    copyFileSync(source, modified);
    writeFileSync(modified, Buffer.concat([sourceBytes, Buffer.from('x')]));
    const result = run(['--source', modified, '--out', out, '--check']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('source size');
  });

  it('refuses a copy into a public/ directory', () => {
    const publicDir = join(tempDir, 'public');
    const result = run([
      '--source',
      source,
      '--out',
      join(tempDir, 'out-copy'),
      '--copy-to',
      join(publicDir, 'copy.img'),
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('public');
  });

  it('refuses a copy that would overwrite the source', () => {
    const result = run([
      '--source',
      source,
      '--out',
      join(tempDir, 'out-copy2'),
      '--copy-to',
      source,
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr.toLowerCase()).toContain('source');
  });

  it('verified copy to an allowed path (identical hash)', () => {
    const destination = join(tempDir, 'copies', 'win7.img');
    const result = run([
      '--source',
      source,
      '--out',
      join(tempDir, 'out-copy3'),
      '--copy-to',
      destination,
    ]);
    expect(result.status).toBe(0);
    expect(existsSync(destination)).toBe(true);
    expect(createHash('sha256').update(readFileSync(destination)).digest('hex')).toBe(sourceHash);
    expect(statSync(destination).size).toBe(sourceBytes.length);
  });

  it('tolerates a lone "--" (injected by pnpm) and keeps the same defaults', () => {
    const out = join(tempDir, 'out-dashdash');
    const result = run(['--source', source, '--out', out, '--', '--skip-hash', '--json']);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('Unknown option');
    const manifest = parseLocalDiskManifest(JSON.parse(result.stdout));
    expect(manifest.ref).toBe('windows-7-pro-sp1-x86');
    expect(manifest.architecture).toBe('i386');
    expect(manifest.memoryMiB).toBe(1536);
    expect(manifest.vgaMemoryMiB).toBe(16);
    expect(manifest.disk.sha256).toBeUndefined();
    expect(manifest.disk.size).toBe(sourceBytes.length);
  });

  it('tolerates a lone "--" before --help', () => {
    const output = execFileSync('node', [SCRIPT, '--', '--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(output).toContain('--source');
    expect(output).toContain('--copy-to');
  });

  it('exposes help without running the preparation', () => {
    const output = execFileSync('node', [SCRIPT, '--help'], { cwd: repoRoot, encoding: 'utf8' });
    expect(output).toContain('--source');
    expect(output).toContain('--copy-to');
  });
});

// Two-media boot: `--esp` adds the second media without touching anything else.
describe('prepare-windows7-asset.mjs --esp', () => {
  const ref = 'windows-11-x64';

  function espRun(extra: string[], outName = 'out-esp') {
    return run([
      '--source',
      source,
      '--ref',
      ref,
      '--architecture',
      'x86_64',
      '--engine',
      'v64',
      '--out',
      join(tempDir, outName),
      ...extra,
    ]);
  }

  it('records the ESP, copies it next to the manifest and keeps disk/boot intact', () => {
    const out = join(tempDir, 'out-esp');
    const result = espRun(['--esp', espSource, '--skip-hash', '--json']);
    expect(result.status).toBe(0);

    const manifest = parseLocalDiskManifest(JSON.parse(result.stdout));
    expect(manifest.esp).toEqual({
      fileName: 'esp.img',
      url: `/images/${ref}/esp.img`,
      size: espBytes.length,
    });
    // Additive contract: `disk`/`boot` still describe the system disk.
    expect(manifest.boot.url).toBe(manifest.disk.url);
    expect(manifest.boot.size).toBe(manifest.disk.size);
    expect(manifest.boot.size).toBe(sourceBytes.length);
    expect(manifest.engine).toEqual({ id: 'v64' });

    // The copy is byte-identical and lives next to the manifest, so the dev
    // middleware can serve `/images/<ref>/esp.img`.
    const copied = join(out, 'esp.img');
    expect(existsSync(copied)).toBe(true);
    expect(createHash('sha256').update(readFileSync(copied)).digest('hex')).toBe(espHash);
    expect(statSync(copied).size).toBe(espBytes.length);
    // No absolute path leaks into the manifest.
    expect(readFileSync(join(out, 'manifest.json'), 'utf8')).not.toContain(tempDir);
    expect(readFileSync(join(out, 'provenance.txt'), 'utf8')).toContain('sha256=' + espHash);
  });

  it('omits the ESP entirely without --esp (byte-identical default manifest)', () => {
    const out = join(tempDir, 'out-no-esp');
    const plain = run([
      '--source',
      source,
      '--ref',
      ref,
      '--architecture',
      'x86_64',
      '--engine',
      'v64',
      '--out',
      out,
      '--skip-hash',
      '--json',
    ]);
    expect(plain.status).toBe(0);
    const manifest = parseLocalDiskManifest(JSON.parse(plain.stdout));
    expect(manifest).not.toHaveProperty('esp');
    expect(existsSync(join(out, 'esp.img'))).toBe(false);
    // Only the ESP key differs between the two manifests.
    const withEsp = parseLocalDiskManifest(
      JSON.parse(espRun(['--esp', espSource, '--skip-hash', '--json', '--force']).stdout),
    );
    expect(withEsp).toEqual({ ...manifest, esp: withEsp.esp });
  });

  it('refuses --esp without the v64 engine', () => {
    const result = run([
      '--source',
      source,
      '--out',
      join(tempDir, 'out-esp-v86'),
      '--esp',
      espSource,
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--esp requires --engine v64');
  });

  it('rejects a missing ESP file', () => {
    const result = espRun(
      ['--esp', join(tempDir, 'absent-esp.img'), '--skip-hash'],
      'out-esp-missing',
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ESP image not found');
  });

  it('verifies the ESP size with --check', () => {
    expect(espRun(['--check']).status).toBe(0);

    // Tampering with the ESP copy is caught by size, which is all the manifest
    // records for it (unlike the hashed NVRAM store).
    const copied = join(tempDir, 'out-esp', 'esp.img');
    const tampered = Buffer.concat([espBytes, Buffer.from('x')]);
    writeFileSync(copied, tampered);
    const result = espRun(['--check']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ESP size');
    writeFileSync(copied, espBytes);
  });
});
