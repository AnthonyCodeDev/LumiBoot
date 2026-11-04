import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLocalDiskManifest } from '../packages/vm-assets/src/local-disk';

// Integration test of the prepare-windows11-asset.mjs wrapper (delegation + UEFI guards).

const repoRoot = process.cwd();
const SCRIPT = join(repoRoot, 'scripts', 'prepare-windows11-asset.mjs');

let tempDir = '';
let source = '';
let sourceBytes: Buffer;
let sourceHash = '';
let firmwareVars = '';
let firmwareVarsBytes: Buffer;
let firmwareVarsHash = '';

function run(args: string[]) {
  return spawnSync('node', [SCRIPT, ...args], { cwd: repoRoot, encoding: 'utf8' });
}

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'lumiboot-prep11-'));
  source = join(tempDir, 'win11.img');
  sourceBytes = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < sourceBytes.length; i += 1) sourceBytes[i] = (i * 17) % 253;
  writeFileSync(source, sourceBytes);
  sourceHash = createHash('sha256').update(sourceBytes).digest('hex');

  // A stand-in OVMF NVRAM store: small, hashed in full by the generator.
  firmwareVars = join(tempDir, 'uefi-vars.fd');
  firmwareVarsBytes = Buffer.alloc(4096);
  for (let i = 0; i < firmwareVarsBytes.length; i += 1) firmwareVarsBytes[i] = (i * 7) % 249;
  writeFileSync(firmwareVars, firmwareVarsBytes);
  firmwareVarsHash = createHash('sha256').update(firmwareVarsBytes).digest('hex');
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('prepare-windows11-asset.mjs', () => {
  it('delegates to the generator with the Windows 11 x64 values (v64 + OVMF)', () => {
    const outDir = join(tempDir, 'out');
    const result = run([
      '--source',
      source,
      '--firmware-vars',
      firmwareVars,
      '--out',
      outDir,
      '--skip-hash',
      '--json',
    ]);
    expect(result.status).toBe(0);
    const manifest = parseLocalDiskManifest(JSON.parse(result.stdout));

    expect(manifest.ref).toBe('windows-11-x64');
    expect(manifest.displayName).toBe('Windows 11 x64');
    expect(manifest.architecture).toBe('x86_64');
    expect(manifest.memoryMiB).toBe(4096);
    expect(manifest.vgaMemoryMiB).toBe(32);
    expect(manifest.disk.format).toBe('raw');
    expect(manifest.disk.size).toBe(sourceBytes.length);
    // `--skip-hash` only skips the disk: the small NVRAM store is always hashed.
    expect(manifest.disk.sha256).toBeUndefined();
    expect(manifest.engine).toEqual({ id: 'v64' });
    expect(manifest.firmware).toEqual({
      type: 'uefi',
      vars: {
        fileName: 'uefi-vars.fd',
        url: '/images/windows-11-x64/uefi-vars.fd',
        size: firmwareVarsBytes.length,
        mtimeMs: Math.trunc(statSync(firmwareVars).mtimeMs),
        sha256: firmwareVarsHash,
      },
    });
    expect(manifest.boot).toEqual({
      mode: 'disk-boot',
      url: '/images/windows-11-x64/disk.img',
      async: true,
      size: sourceBytes.length,
    });
    // The default notes, written for Windows 7, are replaced by the Windows 11 ones.
    expect(manifest.notes?.join(' ')).toContain('Windows 11');
    expect(manifest.notes?.join(' ')).toContain('OVMF');
    expect(manifest.notes?.join(' ')).not.toContain('Windows 7');

    // Both files are written next to each other, with no absolute path in the manifest.
    expect(existsSync(join(outDir, 'manifest.json'))).toBe(true);
    const provenance = readFileSync(join(outDir, 'provenance.txt'), 'utf8');
    expect(provenance).toContain('ref            : windows-11-x64');
    expect(provenance).toContain('format         : raw');
    expect(provenance).toContain('not distributed');
    expect(readFileSync(join(outDir, 'manifest.json'), 'utf8')).not.toContain(tempDir);
  });

  it('hashes the disk when --skip-hash is absent', () => {
    const outDir = join(tempDir, 'out-hash');
    const result = run([
      '--source',
      source,
      '--firmware-vars',
      firmwareVars,
      '--out',
      outDir,
      '--json',
    ]);
    expect(result.status).toBe(0);
    const manifest = parseLocalDiskManifest(JSON.parse(result.stdout));
    expect(manifest.disk.sha256).toBe(sourceHash);
  });

  it('forwards --check (disk + UEFI variable store)', () => {
    const outDir = join(tempDir, 'out-check');
    expect(
      run(['--source', source, '--firmware-vars', firmwareVars, '--out', outDir, '--json']).status,
    ).toBe(0);
    const result = run(['--out', outDir, '--check', '--source', source]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('Manifest matches');
    expect(result.stderr).toContain('firmware vars sha256=');
  });

  it('detects a modified UEFI variable store in --check', () => {
    const outDir = join(tempDir, 'out-check-drift');
    expect(run(['--source', source, '--firmware-vars', firmwareVars, '--out', outDir]).status).toBe(
      0,
    );
    const tampered = join(tempDir, 'uefi-vars-tampered.fd');
    writeFileSync(tampered, Buffer.alloc(firmwareVarsBytes.length, 0x5a));
    const result = run([
      '--out',
      outDir,
      '--check',
      '--source',
      source,
      '--firmware-vars',
      tampered,
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('firmware vars SHA-256');
  });

  it('refuses a v64 engine on a non x86_64 disk', () => {
    const outDir = join(tempDir, 'out-arch');
    const result = run([
      '--source',
      source,
      '--engine',
      'v64',
      '--architecture',
      'i386',
      '--out',
      outDir,
      '--json',
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('x86_64');
    expect(existsSync(join(outDir, 'manifest.json'))).toBe(false);
  });

  it('refuses --firmware-vars without the v64 engine', () => {
    const outDir = join(tempDir, 'out-engine');
    const result = run([
      '--source',
      source,
      '--engine',
      'v86',
      '--firmware-vars',
      firmwareVars,
      '--out',
      outDir,
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--engine v64');
    expect(existsSync(join(outDir, 'manifest.json'))).toBe(false);
  });

  it('refuses a standalone ISO and writes no manifest', () => {
    const iso = join(tempDir, 'win11.iso');
    writeFileSync(iso, sourceBytes);
    const outDir = join(tempDir, 'out-iso');
    const result = run(['--source', iso, '--out', outDir, '--json']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ISO');
    expect(existsSync(join(outDir, 'manifest.json'))).toBe(false);
  });

  it('refuses a QCOW2 and writes no manifest', () => {
    const qcow = join(tempDir, 'win11.qcow2');
    writeFileSync(qcow, sourceBytes);
    const outDir = join(tempDir, 'out-qcow');
    const result = run(['--source', qcow, '--out', outDir, '--json']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('QCOW2');
    expect(existsSync(join(outDir, 'manifest.json'))).toBe(false);
  });

  it('fails readably when no local image is available', () => {
    const missing = join(tempDir, 'absent.img');
    const outDir = join(tempDir, 'out-missing');
    const result = run(['--source', missing, '--out', outDir, '--json']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('No local');
    expect(result.stderr).toContain(missing);
    expect(existsSync(join(outDir, 'manifest.json'))).toBe(false);
  });

  it('fails readably when the OVMF variable store is missing', () => {
    const outDir = join(tempDir, 'out-novars');
    const result = run([
      '--source',
      source,
      '--firmware-vars',
      join(tempDir, 'absent-uefi-vars.fd'),
      '--out',
      outDir,
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('OVMF variable store');
    expect(existsSync(join(outDir, 'manifest.json'))).toBe(false);
  });

  it('tolerates a lone "--" (injected by pnpm) and keeps the v64 defaults', () => {
    const outDir = join(tempDir, 'out-dashdash');
    const result = run([
      '--source',
      source,
      '--firmware-vars',
      firmwareVars,
      '--out',
      outDir,
      '--',
      '--skip-hash',
      '--json',
    ]);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('Unknown option');
    const manifest = parseLocalDiskManifest(JSON.parse(result.stdout));
    expect(manifest.ref).toBe('windows-11-x64');
    expect(manifest.engine.id).toBe('v64');
    expect(manifest.firmware?.type).toBe('uefi');
  });

  it('exposes wrapper-specific help without running the preparation', () => {
    const output = execFileSync('node', [SCRIPT, '--help'], { cwd: repoRoot, encoding: 'utf8' });
    expect(output).toContain('Windows 11');
    expect(output).toContain('--source');
    expect(output).toContain('--firmware-vars');
    expect(output).toContain('--check');
  });
});
