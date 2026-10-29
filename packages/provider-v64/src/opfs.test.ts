import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VMMedia } from '@lumiboot/contracts';
import { ensurePersistentV64Disk } from './opfs';

const media: VMMedia = {
  kind: 'disk',
  url: 'blob:lumiboot-test',
  size: 512,
  format: 'raw',
  sourceId: 'source-1',
};

function installOpfs(
  initial: Record<string, Uint8Array | string> = {},
  options: { failRecordWrite?: boolean } = {},
) {
  const encoder = new TextEncoder();
  const files = new Map(
    Object.entries(initial).map(([name, value]) => [
      name,
      typeof value === 'string' ? encoder.encode(value) : value,
    ]),
  );
  const directory = {
    async getDirectoryHandle() {
      return directory;
    },
    async getFileHandle(name: string, openOptions?: { create?: boolean }) {
      if (!files.has(name) && !openOptions?.create) {
        throw new DOMException('missing', 'NotFoundError');
      }
      return {
        async getFile() {
          const bytes = files.get(name) ?? new Uint8Array();
          return { size: bytes.byteLength, text: async () => new TextDecoder().decode(bytes) };
        },
        async createWritable() {
          const chunks: Uint8Array[] = [];
          const commit = () => {
            if (name === 'system.json' && options.failRecordWrite) {
              throw new Error('metadata write failed');
            }
            files.set(name, new Uint8Array(chunks.flatMap((chunk) => [...chunk])));
          };
          const stream = new WritableStream<Uint8Array>({
            write(chunk) {
              chunks.push(chunk);
            },
            close: commit,
          });
          return Object.assign(stream, {
            async write(value: string | Uint8Array) {
              chunks.push(typeof value === 'string' ? encoder.encode(value) : value);
            },
            async close() {
              commit();
            },
            async abort() {
              chunks.length = 0;
            },
          });
        },
      };
    },
    async removeEntry(name: string) {
      files.delete(name);
    },
  };
  vi.stubGlobal('navigator', {
    storage: { getDirectory: async () => directory, persist: async () => true },
  });
  return files;
}

function diskRecord(sourceId: string): string {
  return JSON.stringify({ sourceId, size: 512, updatedAt: '2026-01-01' });
}

function diskFileName(url: string): string {
  return url.slice(url.lastIndexOf('/') + 1);
}

afterEach(() => vi.unstubAllGlobals());

describe('ensurePersistentV64Disk', () => {
  it('rejects zero-length and negative disks before touching storage', async () => {
    await expect(ensurePersistentV64Disk('system', { ...media, size: 0 })).rejects.toThrow(
      'whole 512-byte sectors',
    );
    await expect(ensurePersistentV64Disk('system', { ...media, size: -512 })).rejects.toThrow(
      'whole 512-byte sectors',
    );
  });

  it('reimports a disk when its metadata exists but the image file is missing', async () => {
    const files = installOpfs({ 'system.json': diskRecord('source-1') });
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(512)));
    vi.stubGlobal('fetch', fetchImpl);

    const result = await ensurePersistentV64Disk('system', media);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(result.url).toMatch(/^opfs:lumiboot\/v64\/disks\/system-[0-9a-f]{32}\.img$/);
    expect(files.get(diskFileName(result.url))?.byteLength).toBe(512);
  });

  it('keeps a matching legacy disk without importing it again', async () => {
    installOpfs({ 'system.json': diskRecord('source-1'), 'system.img': new Uint8Array(512) });
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);

    await expect(ensurePersistentV64Disk('system', media)).resolves.toEqual({
      url: 'opfs:lumiboot/v64/disks/system.img',
      size: 512,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('preserves the active disk when the replacement has the wrong size', async () => {
    const files = installOpfs({
      'system.json': diskRecord('source-1'),
      'system.img': new Uint8Array(512).fill(7),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(256))),
    );

    await expect(
      ensurePersistentV64Disk('system', { ...media, sourceId: 'source-2' }),
    ).rejects.toThrow('256 bytes instead of 512');
    expect([...files.keys()].sort()).toEqual(['system.img', 'system.json']);
    expect(files.get('system.img')?.[0]).toBe(7);
    expect(new TextDecoder().decode(files.get('system.json'))).toBe(diskRecord('source-1'));

    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    await expect(ensurePersistentV64Disk('system', media)).resolves.toMatchObject({
      url: 'opfs:lumiboot/v64/disks/system.img',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('switches to a validated copy and removes the previous generation', async () => {
    const files = installOpfs({
      'system.json': diskRecord('source-1'),
      'system.img': new Uint8Array(512).fill(7),
    });
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(512).fill(9)));
    vi.stubGlobal('fetch', fetchImpl);
    const replacement = { ...media, sourceId: 'source-2' };

    const result = await ensurePersistentV64Disk('system', replacement);
    const record = JSON.parse(new TextDecoder().decode(files.get('system.json'))) as {
      sourceId: string;
      fileName: string;
    };

    expect(result.url).toContain(record.fileName);
    expect(record.sourceId).toBe('source-2');
    expect(files.get(record.fileName)?.[0]).toBe(9);
    // The previous generation is reclaimed once the new record is committed.
    expect(files.has('system.img')).toBe(false);
    await expect(ensurePersistentV64Disk('system', replacement)).resolves.toEqual(result);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('keeps a single generation across repeated imports', async () => {
    const files = installOpfs();
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(512).fill(9)));
    vi.stubGlobal('fetch', fetchImpl);

    await ensurePersistentV64Disk('system', { ...media, sourceId: 'source-1' });
    await ensurePersistentV64Disk('system', { ...media, sourceId: 'source-2' });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect([...files.keys()].sort()).toEqual([
      expect.stringMatching(/^system-[0-9a-f]{32}\.img$/),
      'system.json',
    ]);
    const record = JSON.parse(new TextDecoder().decode(files.get('system.json'))) as {
      sourceId: string;
      fileName: string;
    };
    expect(record.sourceId).toBe('source-2');
    expect(files.get(record.fileName)?.byteLength).toBe(512);
  });

  it('retains the old image if writing the new metadata fails', async () => {
    const files = installOpfs(
      { 'system.json': diskRecord('source-1'), 'system.img': new Uint8Array(512).fill(7) },
      { failRecordWrite: true },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(512).fill(9))),
    );

    await expect(
      ensurePersistentV64Disk('system', { ...media, sourceId: 'source-2' }),
    ).rejects.toThrow('metadata write failed');
    expect(files.get('system.img')?.[0]).toBe(7);
    expect(new TextDecoder().decode(files.get('system.json'))).toBe(diskRecord('source-1'));
    // Preserve the candidate: the browser may commit the metadata before close() fails.
    expect([...files.keys()].some((name) => /^system-[0-9a-f]{32}\.img$/.test(name))).toBe(true);
  });
});
