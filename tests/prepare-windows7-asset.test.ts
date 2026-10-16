import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLocalDiskManifest } from '../packages/vm-assets/src/local-disk';

/**
 * Test d'intégration du pipeline réel `scripts/prepare-windows7-asset.mjs` :
 * on lance le script avec une petite image temporaire (jamais le vrai disque
 * de 32 Gio) et on valide sa sortie avec le schéma `@lumiboot/vm-assets`.
 * Preuve que l'outil est réutilisable et que sa sortie est conforme.
 */

const repoRoot = process.cwd();
const SCRIPT = join(repoRoot, 'scripts', 'prepare-windows7-asset.mjs');

let tempDir = '';
let source = '';
let outDir = '';
let sourceBytes: Buffer;
let sourceHash = '';

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
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('prepare-windows7-asset.mjs', () => {
  it('génère un manifeste conforme (avec SHA-256 réel)', () => {
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
  });

  it('n’écrase ni ne modifie le fichier source', () => {
    const before = statSync(source);
    const result = run(['--source', source, '--out', outDir, '--force', '--json']);
    expect(result.status).toBe(0);
    const after = statSync(source);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(createHash('sha256').update(readFileSync(source)).digest('hex')).toBe(sourceHash);
  });

  it('refuse d’écraser un manifeste existant sans --force', () => {
    const result = run(['--source', source, '--out', outDir, '--skip-hash']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--check');
  });

  it('supporte --skip-hash (taille + mtime documentés, pas de SHA)', () => {
    const out = join(tempDir, 'out-skip');
    const result = run(['--source', source, '--out', out, '--skip-hash', '--json']);
    expect(result.status).toBe(0);
    const manifest = parseLocalDiskManifest(JSON.parse(result.stdout));
    expect(manifest.disk.sha256).toBeUndefined();
    expect(manifest.disk.size).toBe(sourceBytes.length);
  });

  it('vérifie un manifeste existant avec --check', () => {
    const result = run(['--source', source, '--out', outDir, '--check']);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('conforme');
  });

  it('détecte une source modifiée avec --check', () => {
    const out = join(tempDir, 'out-check');
    run(['--source', source, '--out', out, '--skip-hash']);
    // Modifie la source APRÈS génération : la taille diffère -> échec attendu.
    const modified = join(tempDir, 'modified.img');
    copyFileSync(source, modified);
    writeFileSync(modified, Buffer.concat([sourceBytes, Buffer.from('x')]));
    const result = run(['--source', modified, '--out', out, '--check']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('taille');
  });

  it('refuse une copie vers un dossier public/', () => {
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

  it('refuse une copie qui écraserait la source', () => {
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

  it('copie vérifiée vers un chemin autorisé (hash identique)', () => {
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

  it('expose une aide sans exécuter la préparation', () => {
    const output = execFileSync('node', [SCRIPT, '--help'], { cwd: repoRoot, encoding: 'utf8' });
    expect(output).toContain('--source');
    expect(output).toContain('--copy-to');
  });
});
