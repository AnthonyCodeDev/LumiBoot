import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLocalDiskManifest } from '../packages/vm-assets/src/local-disk';

/**
 * Test d'intégration du wrapper `scripts/prepare-windows10-asset.mjs` : on
 * vérifie qu'il DÉLÈGUE au générateur éprouvé en fixant les valeurs Windows 10
 * x86 (ref, display-name, architecture, mémoire, VGA), qu'il propage les
 * options CLI (--check/--force/--skip-hash/--json) et qu'il REFUSE les médias
 * non amorçables en `hda` (ISO seule, QCOW2) sans jamais écrire de faux
 * manifeste. On utilise une petite image temporaire, jamais le vrai disque.
 */

const repoRoot = process.cwd();
const SCRIPT = join(repoRoot, 'scripts', 'prepare-windows10-asset.mjs');

let tempDir = '';
let source = '';
let sourceBytes: Buffer;
let sourceHash = '';

function run(args: string[]) {
  return spawnSync('node', [SCRIPT, ...args], { cwd: repoRoot, encoding: 'utf8' });
}

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'lumiboot-prep10-'));
  source = join(tempDir, 'win10.img');
  sourceBytes = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < sourceBytes.length; i += 1) sourceBytes[i] = (i * 13) % 251;
  writeFileSync(source, sourceBytes);
  sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('prepare-windows10-asset.mjs', () => {
  it('délègue au générateur avec les valeurs Windows 10 x86', () => {
    const outDir = join(tempDir, 'out');
    const result = run(['--source', source, '--out', outDir, '--json']);
    expect(result.status).toBe(0);
    const manifest = parseLocalDiskManifest(JSON.parse(result.stdout));

    expect(manifest.ref).toBe('windows-10-x86');
    expect(manifest.displayName).toBe('Windows 10 x86');
    expect(manifest.architecture).toBe('i386');
    expect(manifest.memoryMiB).toBe(2048);
    expect(manifest.vgaMemoryMiB).toBe(16);
    expect(manifest.disk.format).toBe('raw');
    expect(manifest.disk.size).toBe(sourceBytes.length);
    expect(manifest.disk.sha256).toBe(sourceHash);
    expect(manifest.boot).toEqual({
      mode: 'disk-boot',
      url: '/images/windows-10-x86/disk.img',
      async: true,
      size: sourceBytes.length,
    });
    expect(manifest.engine.wasm.sha256).toHaveLength(64);
    // Les notes par défaut (Windows 7) sont remplacées par celles de Windows 10.
    expect(manifest.notes?.join(' ')).toContain('Windows 10');
    expect(manifest.notes?.join(' ')).not.toContain('Windows 7');
  });

  it('n’écrase ni ne modifie le fichier source', () => {
    const outDir = join(tempDir, 'out-preserve');
    const before = statSync(source);
    expect(run(['--source', source, '--out', outDir, '--json']).status).toBe(0);
    expect(run(['--source', source, '--out', outDir, '--force', '--json']).status).toBe(0);
    const after = statSync(source);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(createHash('sha256').update(readFileSync(source)).digest('hex')).toBe(sourceHash);
  });

  it('propage --skip-hash (taille + mtime documentés, pas de SHA)', () => {
    const outDir = join(tempDir, 'out-skip');
    const result = run(['--source', source, '--out', outDir, '--skip-hash', '--json']);
    expect(result.status).toBe(0);
    const manifest = parseLocalDiskManifest(JSON.parse(result.stdout));
    expect(manifest.disk.sha256).toBeUndefined();
    expect(manifest.disk.size).toBe(sourceBytes.length);
  });

  it('propage --force (refus sans --force, succès avec)', () => {
    const outDir = join(tempDir, 'out-force');
    expect(run(['--source', source, '--out', outDir, '--skip-hash']).status).toBe(0);
    const refused = run(['--source', source, '--out', outDir, '--skip-hash']);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('--check');
    const forced = run(['--source', source, '--out', outDir, '--skip-hash', '--force']);
    expect(forced.status).toBe(0);
  });

  it('propage --check (vérifie le manifeste existant sans --source)', () => {
    const outDir = join(tempDir, 'out-check');
    expect(run(['--source', source, '--out', outDir, '--json']).status).toBe(0);
    const result = run(['--out', outDir, '--check']);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('conforme');
  });

  it('refuse une ISO seule et n’écrit aucun manifeste', () => {
    const iso = join(tempDir, 'win10.iso');
    writeFileSync(iso, sourceBytes);
    const outDir = join(tempDir, 'out-iso');
    const result = run(['--source', iso, '--out', outDir, '--json']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ISO');
    expect(existsSync(join(outDir, 'manifest.json'))).toBe(false);
  });

  it('refuse un QCOW2 et n’écrit aucun manifeste', () => {
    const qcow = join(tempDir, 'win10.qcow2');
    writeFileSync(qcow, sourceBytes);
    const outDir = join(tempDir, 'out-qcow');
    const result = run(['--source', qcow, '--out', outDir, '--json']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('QCOW2');
    expect(existsSync(join(outDir, 'manifest.json'))).toBe(false);
  });

  it('refuse --format iso même sur un fichier .img', () => {
    const outDir = join(tempDir, 'out-format');
    const result = run(['--source', source, '--out', outDir, '--format', 'iso', '--json']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ISO');
    expect(existsSync(join(outDir, 'manifest.json'))).toBe(false);
  });

  it('échoue lisiblement quand aucune image locale n’est disponible', () => {
    const missing = join(tempDir, 'absent.img');
    const outDir = join(tempDir, 'out-missing');
    const result = run(['--source', missing, '--out', outDir, '--json']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Aucune image locale');
    expect(result.stderr).toContain(missing);
    expect(existsSync(join(outDir, 'manifest.json'))).toBe(false);
  });

  it('tolère un « -- » isolé (injecté par pnpm) et garde les mêmes défauts', () => {
    const outDir = join(tempDir, 'out-dashdash');
    const result = run(['--source', source, '--out', outDir, '--', '--skip-hash', '--json']);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('Option inconnue');
    const manifest = parseLocalDiskManifest(JSON.parse(result.stdout));
    expect(manifest.ref).toBe('windows-10-x86');
    expect(manifest.displayName).toBe('Windows 10 x86');
    expect(manifest.architecture).toBe('i386');
    expect(manifest.memoryMiB).toBe(2048);
    expect(manifest.vgaMemoryMiB).toBe(16);
    expect(manifest.disk.sha256).toBeUndefined();
    expect(manifest.disk.size).toBe(sourceBytes.length);
  });

  it('tolère un « -- » isolé devant --help', () => {
    const output = execFileSync('node', [SCRIPT, '--', '--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(output).toContain('Windows 10');
    expect(output).toContain('--source');
  });

  it('expose une aide propre au wrapper sans exécuter la préparation', () => {
    const output = execFileSync('node', [SCRIPT, '--help'], { cwd: repoRoot, encoding: 'utf8' });
    expect(output).toContain('Windows 10');
    expect(output).toContain('--source');
    expect(output).toContain('--check');
  });
});
