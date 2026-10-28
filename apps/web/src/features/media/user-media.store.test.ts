import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryUserMediaStore } from '@lumiboot/vm-assets';
import { getSystemById } from '@lumiboot/catalog';
import {
  MAX_USER_MEDIA_BYTES,
  detectMediaFormat,
  mediaFormatForFile,
  useUserMediaStore,
  validateUserMediaFile,
} from './user-media.store';
import { getUserMediaStore } from './user-media.storage';

/** `getUserMediaStore` is replaced by a real in-memory `vm-assets` store. */

vi.mock('./user-media.storage', () => ({
  getUserMediaStore: vi.fn(),
}));

const getStoreMock = vi.mocked(getUserMediaStore);
// Generic entry point: any local disk media supplied by the user.
const system = getSystemById('custom-image');
if (!system) throw new Error('test system not found');

function makeFile(name: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type: 'application/octet-stream' });
}

const fileLike = (name: string, size: number): File => ({ name, size }) as unknown as File;

let originalStorage: PropertyDescriptor | undefined;

beforeEach(() => {
  getStoreMock.mockReset();
  useUserMediaStore.setState({ records: {}, loading: false, importing: false, error: undefined });
  originalStorage = Object.getOwnPropertyDescriptor(navigator, 'storage');
});

afterEach(() => {
  if (originalStorage) Object.defineProperty(navigator, 'storage', originalStorage);
  else delete (navigator as unknown as Record<string, unknown>)['storage'];
});

describe('format detection', () => {
  it('infers the format from recognized extensions', () => {
    expect(detectMediaFormat('windows.ISO')).toBe('iso');
    expect(detectMediaFormat('debian.img')).toBe('raw');
    expect(mediaFormatForFile('debian.iso')).toBe('iso');
    expect(mediaFormatForFile('debian.img')).toBe('raw');
    expect(mediaFormatForFile('debian.raw')).toBe('raw');
    expect(mediaFormatForFile('archive.zip')).toBeNull();
  });
});

describe('validateUserMediaFile', () => {
  it('accepts a file under the cap', () => {
    expect(validateUserMediaFile({ name: 'image.img', size: 2048 })).toEqual({ format: 'raw' });
  });

  it('rejects an unknown extension', () => {
    expect(() => validateUserMediaFile({ name: 'archive.zip', size: 2048 })).toThrow(
      /Accepted extensions/,
    );
  });

  it('rejects an empty file', () => {
    expect(() => validateUserMediaFile({ name: 'empty.img', size: 0 })).toThrow(/empty/);
  });

  it('rejects a file above the cap', () => {
    expect(() =>
      validateUserMediaFile({ name: 'huge.img', size: MAX_USER_MEDIA_BYTES + 1 }),
    ).toThrow(/maximum allowed size/);
  });
});

describe('useUserMediaStore.importFor', () => {
  it('imports a valid media and persists it locally', async () => {
    const store = createMemoryUserMediaStore();
    getStoreMock.mockResolvedValue(store);

    await useUserMediaStore.getState().importFor(system, makeFile('custom.iso', 4096), true);

    const record = useUserMediaStore.getState().records[system.id];
    expect(record?.format).toBe('iso');
    expect(record?.size).toBe(4096);
    expect(await store.get(system.id)).toEqual(record);
    expect(await store.getBytes(system.id)).not.toBeNull();
    expect(useUserMediaStore.getState().error).toBeUndefined();
  });

  it('refuses the import without a license confirmation, without touching storage', async () => {
    await expect(
      useUserMediaStore.getState().importFor(system, makeFile('custom.iso', 4096), false),
    ).rejects.toMatchObject({ code: 'ASSET_IMPORT_REJECTED' });

    expect(useUserMediaStore.getState().error).toMatch(/license/i);
    expect(useUserMediaStore.getState().importing).toBe(false);
    expect(getStoreMock).not.toHaveBeenCalled();
  });

  it('refuses an unknown extension with an actionable message', async () => {
    await expect(
      useUserMediaStore.getState().importFor(system, makeFile('archive.zip', 4096), true),
    ).rejects.toMatchObject({ code: 'ASSET_IMPORT_REJECTED' });

    expect(useUserMediaStore.getState().error).toContain('.iso');
    expect(getStoreMock).not.toHaveBeenCalled();
  });

  it('refuses an oversized media without reading the bytes', async () => {
    await expect(
      useUserMediaStore
        .getState()
        .importFor(system, fileLike('huge.img', MAX_USER_MEDIA_BYTES + 1), true),
    ).rejects.toMatchObject({ code: 'ASSET_IMPORT_REJECTED' });

    expect(useUserMediaStore.getState().error).toMatch(/maximum allowed size/);
    expect(getStoreMock).not.toHaveBeenCalled();
  });

  it('refuses the import when the local quota is insufficient', async () => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { estimate: vi.fn(async () => ({ quota: 1000, usage: 900 })) },
    });

    await expect(
      useUserMediaStore.getState().importFor(system, makeFile('custom.img', 4096), true),
    ).rejects.toMatchObject({ code: 'ASSET_CACHE_QUOTA_EXCEEDED' });

    expect(useUserMediaStore.getState().error).toMatch(/Not enough storage/i);
    expect(getStoreMock).not.toHaveBeenCalled();
  });

  it('reports an unreadable JSON manifest', async () => {
    const manifest = {
      name: 'manifest.json',
      text: async () => '{ this is not JSON',
    } as unknown as File;
    await expect(
      useUserMediaStore.getState().importFor(system, makeFile('custom.img', 4096), true, manifest),
    ).rejects.toMatchObject({ code: 'ASSET_INVALID_MANIFEST' });
    expect(useUserMediaStore.getState().error).toMatch(/invalid JSON/);
  });

  it('rejects a manifest whose reference does not match the system', async () => {
    const manifest = {
      name: 'manifest.json',
      text: async () =>
        JSON.stringify({
          version: 1,
          ref: 'other-system',
          displayName: 'Other',
          format: 'raw',
          architecture: 'i386',
          license: 'x',
          provenance: 'y',
        }),
    } as unknown as File;
    await expect(
      useUserMediaStore.getState().importFor(system, makeFile('custom.img', 4096), true, manifest),
    ).rejects.toMatchObject({ code: 'ASSET_INVALID_MANIFEST' });
    expect(useUserMediaStore.getState().error).toMatch(/reference/i);
  });
});

describe('useUserMediaStore.remove', () => {
  it('removes the media from local storage and from the state', async () => {
    const store = createMemoryUserMediaStore();
    getStoreMock.mockResolvedValue(store);
    await useUserMediaStore.getState().importFor(system, makeFile('custom.iso', 2048), true);

    await useUserMediaStore.getState().remove(system.id);

    expect(useUserMediaStore.getState().records[system.id]).toBeUndefined();
    expect(await store.get(system.id)).toBeNull();
    expect(await store.getBytes(system.id)).toBeNull();
  });
});
