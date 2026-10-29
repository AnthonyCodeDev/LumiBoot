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
    displayName: 'Windows 7 x86 (local media)',
    architecture: 'i386',
    memoryMiB: 1024,
    vgaMemoryMiB: 16,
    license: 'User license',
    provenance: 'Local disk',
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
  it('accepts a complete conforming manifest', () => {
    const manifest = parseLocalDiskManifest(validManifest());
    expect(manifest.ref).toBe('windows-7-x86');
    expect(manifest.disk.size).toBe(SIZE);
    expect(manifest.boot.async).toBe(true);
  });

  it('accepts a public form (without source or provenance)', () => {
    const raw = validManifest();
    delete raw.source;
    delete raw.provenance;
    const manifest = parseLocalDiskManifest(raw);
    expect(manifest.source).toBeUndefined();
    expect(manifest.provenance).toBeUndefined();
  });

  it('accepts the encoded token added by the loopback disk server', () => {
    const raw = validManifest();
    const suffix = '?token=a%20b%26c';
    (raw.disk as Record<string, unknown>).url += suffix;
    (raw.boot as Record<string, unknown>).url += suffix;
    const engine = raw.engine as Record<string, unknown>;
    (engine.wasm as Record<string, unknown>).url += suffix;
    const bios = engine.bios as Record<string, unknown>;
    (bios.seabios as Record<string, unknown>).url += suffix;
    (bios.vgabios as Record<string, unknown>).url += suffix;

    expect(parseLocalDiskManifest(raw).boot.url).toContain(suffix);
    delete raw.source;
    delete raw.provenance;
    expect(parseLocalDiskPublicManifest(raw).boot.url).toContain(suffix);
  });

  it('accepts a manifest without SHA-256 (size + mtime documented)', () => {
    const raw = validManifest();
    delete (raw.disk as Record<string, unknown>).sha256;
    const manifest = parseLocalDiskManifest(raw);
    expect(manifest.disk.sha256).toBeUndefined();
  });

  it('rejects an unknown key (.strict)', () => {
    const raw = validManifest();
    raw.extra = true;
    expect(() => parseLocalDiskManifest(raw)).toThrow(AssetError);
  });

  it('rejects a disk URL outside /images/', () => {
    const raw = validManifest();
    (raw.disk as Record<string, unknown>).url = 'https://exemple.test/disk.img';
    expect(() => parseLocalDiskManifest(raw)).toThrow(AssetError);
  });

  it.each(['/images/../other/disk.img', '/images/windows-7-x86/%2e%2e', '/images/other/disk.img'])(
    'rejects an unsafe or unrelated disk URL: %s',
    (url) => {
      const raw = validManifest();
      (raw.disk as Record<string, unknown>).url = url;
      (raw.boot as Record<string, unknown>).url = url;
      expect(() => parseLocalDiskManifest(raw)).toThrow(AssetError);
    },
  );

  it.each(['?token=a&other=b', '#fragment', '?token=%2e%2e/other'])(
    'rejects an unsafe disk URL suffix: %s',
    (suffix) => {
      const raw = validManifest();
      const url = `/images/windows-7-x86/disk.img${suffix}`;
      (raw.disk as Record<string, unknown>).url = url;
      (raw.boot as Record<string, unknown>).url = url;
      expect(() => parseLocalDiskManifest(raw)).toThrow(AssetError);
    },
  );

  it('rejects a boot URL or size that differs from the disk', () => {
    const raw = validManifest();
    (raw.boot as Record<string, unknown>).url = '/images/windows-7-x86/other.img';
    expect(() => parseLocalDiskManifest(raw)).toThrow(AssetError);
    (raw.boot as Record<string, unknown>).url = '/images/windows-7-x86/disk.img';
    (raw.boot as Record<string, unknown>).size = SIZE - 1;
    expect(() => parseLocalDiskManifest(raw)).toThrow(AssetError);
  });

  it('rejects an engine binary outside /v86/', () => {
    const raw = validManifest();
    ((raw.engine as Record<string, unknown>).wasm as Record<string, unknown>).url = '/other/x';
    expect(() => parseLocalDiskManifest(raw)).toThrow(AssetError);
  });

  it('rejects a non-positive size', () => {
    const raw = validManifest();
    (raw.disk as Record<string, unknown>).size = 0;
    expect(() => parseLocalDiskManifest(raw)).toThrow(AssetError);
  });

  it('rejects a non-hexadecimal 64-character SHA-256', () => {
    const raw = validManifest();
    (raw.disk as Record<string, unknown>).sha256 = 'deadbeef';
    expect(() => parseLocalDiskManifest(raw)).toThrow(AssetError);
  });
});

describe('helpers', () => {
  const manifest = parseLocalDiskManifest(validManifest());

  it('toV86AsyncDrive produces an async hda with the exact size', () => {
    expect(toV86AsyncDrive(manifest)).toEqual({
      url: '/images/windows-7-x86/disk.img',
      async: true,
      size: SIZE,
    });
  });

  it('toLocalDiskMedia produces a VMMedia-compatible disk media', () => {
    expect(toLocalDiskMedia(manifest)).toEqual({
      kind: 'disk',
      url: '/images/windows-7-x86/disk.img',
      size: SIZE,
      format: 'raw',
      sha256: HEX,
    });
  });

  it('toLocalDiskMedia omits sha256 when absent', () => {
    const raw = validManifest();
    delete (raw.disk as Record<string, unknown>).sha256;
    const withoutHash = parseLocalDiskManifest(raw);
    expect(toLocalDiskMedia(withoutHash)).not.toHaveProperty('sha256');
  });
});

describe('diffLocalDiskIntegrity', () => {
  const manifest: LocalDiskManifest = parseLocalDiskManifest(validManifest());

  it('reports nothing when everything matches', () => {
    expect(
      diffLocalDiskIntegrity(manifest, {
        size: SIZE,
        mtimeMs: 1792155200430,
        sha256: HEX,
      }),
    ).toEqual([]);
  });

  it('reports diverging size, mtime and checksum', () => {
    const problems = diffLocalDiskIntegrity(manifest, {
      size: SIZE + 1,
      mtimeMs: 1,
      sha256: 'f'.repeat(64),
    });
    expect(problems).toHaveLength(3);
  });
});

describe('public/private serialization', () => {
  const privateManifest = parseLocalDiskManifest(validManifest());

  it('toPublicLocalDiskManifest removes source and provenance', () => {
    const publicManifest = toPublicLocalDiskManifest(privateManifest);
    expect(publicManifest).not.toHaveProperty('source');
    expect(publicManifest).not.toHaveProperty('provenance');
    expect(publicManifest.disk).toEqual(privateManifest.disk);
    expect(publicManifest.boot).toEqual(privateManifest.boot);
  });

  it('leaks NO absolute source path in the public JSON', () => {
    const json = JSON.stringify(toPublicLocalDiskManifest(privateManifest));
    expect(json).not.toContain('C:/Windows7.img');
    expect(json).not.toContain('source');
    expect(json).not.toContain('provenance');
  });

  it('parseLocalDiskPublicManifest rejects a manifest exposing source/provenance', () => {
    expect(() => parseLocalDiskPublicManifest(validManifest())).toThrow(AssetError);
  });

  it('parseLocalDiskPublicManifest accepts the serialized public form', () => {
    const publicManifest = parseLocalDiskPublicManifest(toPublicLocalDiskManifest(privateManifest));
    expect(publicManifest.ref).toBe('windows-7-x86');
    expect(publicManifest).not.toHaveProperty('source');
    expect(publicManifest).not.toHaveProperty('provenance');
  });
});
