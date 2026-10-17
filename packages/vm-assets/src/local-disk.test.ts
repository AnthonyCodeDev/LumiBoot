import { describe, expect, it } from 'vitest';
import { AssetError } from './errors';
import {
  diffLocalDiskIntegrity,
  parseLocalDiskManifest,
  parseLocalDiskPublicManifest,
  toLocalDiskMedia,
  toPublicLocalDiskManifest,
  toV86AsyncDrive,
  type LocalDiskManifest,
} from './local-disk';

const HEX = 'a'.repeat(64);
const SIZE = 17179869184;

function validManifest(): Record<string, unknown> {
  return {
    version: 1,
    ref: 'windows-7-x86',
    displayName: 'Windows 7 x86 (média local)',
    architecture: 'i386',
    memoryMiB: 1024,
    vgaMemoryMiB: 16,
    license: 'Licence utilisateur',
    provenance: 'Disque local',
    source: { path: 'C:/Windows7.img', size: SIZE, mtimeMs: 1792155200430 },
    disk: {
      fileName: 'disk.img',
      format: 'raw',
      url: '/images/windows-7-x86/disk.img',
      size: SIZE,
      mtimeMs: 1792155200430,
      sha256: HEX,
    },
    engine: {
      id: 'v86',
      wasm: { url: '/v86/v86.wasm', size: 2007347, sha256: 'b'.repeat(64) },
      bios: {
        seabios: { url: '/v86/seabios.bin', size: 131072, sha256: 'c'.repeat(64) },
        vgabios: { url: '/v86/vgabios.bin', size: 36352, sha256: 'd'.repeat(64) },
      },
    },
    boot: {
      mode: 'disk-boot',
      url: '/images/windows-7-x86/disk.img',
      async: true,
      size: SIZE,
    },
  };
}

describe('parseLocalDiskManifest', () => {
  it('accepte un manifeste complet conforme', () => {
    const manifest = parseLocalDiskManifest(validManifest());
    expect(manifest.ref).toBe('windows-7-x86');
    expect(manifest.disk.size).toBe(SIZE);
    expect(manifest.boot.async).toBe(true);
  });

  it('accepte une forme publique (sans source ni provenance)', () => {
    const raw = validManifest();
    delete raw.source;
    delete raw.provenance;
    const manifest = parseLocalDiskManifest(raw);
    expect(manifest.source).toBeUndefined();
    expect(manifest.provenance).toBeUndefined();
  });

  it('accepte un manifeste sans SHA-256 (taille + mtime documentés)', () => {
    const raw = validManifest();
    delete (raw.disk as Record<string, unknown>).sha256;
    const manifest = parseLocalDiskManifest(raw);
    expect(manifest.disk.sha256).toBeUndefined();
  });

  it('rejette une clé inconnue (.strict)', () => {
    const raw = validManifest();
    raw.extra = true;
    expect(() => parseLocalDiskManifest(raw)).toThrow(AssetError);
  });

  it('rejette une URL disque hors /images/', () => {
    const raw = validManifest();
    (raw.disk as Record<string, unknown>).url = 'https://exemple.test/disk.img';
    expect(() => parseLocalDiskManifest(raw)).toThrow(AssetError);
  });

  it('rejette un binaire moteur hors /v86/', () => {
    const raw = validManifest();
    ((raw.engine as Record<string, unknown>).wasm as Record<string, unknown>).url = '/other/x';
    expect(() => parseLocalDiskManifest(raw)).toThrow(AssetError);
  });

  it('rejette une taille non positive', () => {
    const raw = validManifest();
    (raw.disk as Record<string, unknown>).size = 0;
    expect(() => parseLocalDiskManifest(raw)).toThrow(AssetError);
  });

  it('rejette un SHA-256 non hexadécimal de 64 caractères', () => {
    const raw = validManifest();
    (raw.disk as Record<string, unknown>).sha256 = 'deadbeef';
    expect(() => parseLocalDiskManifest(raw)).toThrow(AssetError);
  });
});

describe('helpers', () => {
  const manifest = parseLocalDiskManifest(validManifest());

  it('toV86AsyncDrive produit hda async avec la taille exacte', () => {
    expect(toV86AsyncDrive(manifest)).toEqual({
      url: '/images/windows-7-x86/disk.img',
      async: true,
      size: SIZE,
    });
  });

  it('toLocalDiskMedia produit un média disque compatible VMMedia', () => {
    expect(toLocalDiskMedia(manifest)).toEqual({
      kind: 'disk',
      url: '/images/windows-7-x86/disk.img',
      size: SIZE,
      format: 'raw',
      sha256: HEX,
    });
  });

  it('toLocalDiskMedia omet sha256 si absent', () => {
    const raw = validManifest();
    delete (raw.disk as Record<string, unknown>).sha256;
    const withoutHash = parseLocalDiskManifest(raw);
    expect(toLocalDiskMedia(withoutHash)).not.toHaveProperty('sha256');
  });
});

describe('diffLocalDiskIntegrity', () => {
  const manifest: LocalDiskManifest = parseLocalDiskManifest(validManifest());

  it('ne signale rien quand tout concorde', () => {
    expect(
      diffLocalDiskIntegrity(manifest, {
        size: SIZE,
        mtimeMs: 1792155200430,
        sha256: HEX,
      }),
    ).toEqual([]);
  });

  it('signale taille, mtime et empreinte divergents', () => {
    const problems = diffLocalDiskIntegrity(manifest, {
      size: SIZE + 1,
      mtimeMs: 1,
      sha256: 'f'.repeat(64),
    });
    expect(problems).toHaveLength(3);
  });
});

describe('sérialisation publique/privée', () => {
  const privateManifest = parseLocalDiskManifest(validManifest());

  it('toPublicLocalDiskManifest retire source et provenance', () => {
    const publicManifest = toPublicLocalDiskManifest(privateManifest);
    expect(publicManifest).not.toHaveProperty('source');
    expect(publicManifest).not.toHaveProperty('provenance');
    expect(publicManifest.disk).toEqual(privateManifest.disk);
    expect(publicManifest.boot).toEqual(privateManifest.boot);
  });

  it('ne diffuse AUCUN chemin source absolu dans le JSON public', () => {
    const json = JSON.stringify(toPublicLocalDiskManifest(privateManifest));
    expect(json).not.toContain('C:/Windows7.img');
    expect(json).not.toContain('source');
    expect(json).not.toContain('provenance');
  });

  it('parseLocalDiskPublicManifest rejette un manifeste exposant source/provenance', () => {
    expect(() => parseLocalDiskPublicManifest(validManifest())).toThrow(AssetError);
  });

  it('parseLocalDiskPublicManifest accepte la forme publique sérialisée', () => {
    const publicManifest = parseLocalDiskPublicManifest(toPublicLocalDiskManifest(privateManifest));
    expect(publicManifest.ref).toBe('windows-7-x86');
    expect(publicManifest).not.toHaveProperty('source');
    expect(publicManifest).not.toHaveProperty('provenance');
  });
});
