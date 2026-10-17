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

/**
 * Tests du store des médias utilisateur : validation (extension, format, taille,
 * quota, attestation de licence), messages d'échec clairs et stockage local.
 * `getUserMediaStore` est remplacé par un store mémoire réel de `vm-assets` :
 * la logique d'import testée est celle du store front, pas IndexedDB.
 */

vi.mock('./user-media.storage', () => ({
  getUserMediaStore: vi.fn(),
}));

const getStoreMock = vi.mocked(getUserMediaStore);
const system = getSystemById('windows-11-x64');
if (!system) throw new Error('système de test introuvable');

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

describe('détection de format', () => {
  it('déduit le format des extensions reconnues', () => {
    expect(detectMediaFormat('windows.ISO')).toBe('iso');
    expect(detectMediaFormat('debian.img')).toBe('raw');
    expect(mediaFormatForFile('debian.iso')).toBe('iso');
    expect(mediaFormatForFile('debian.img')).toBe('raw');
    expect(mediaFormatForFile('debian.raw')).toBe('raw');
    expect(mediaFormatForFile('archive.zip')).toBeNull();
  });
});

describe('validateUserMediaFile', () => {
  it('accepte un fichier sous le plafond', () => {
    expect(validateUserMediaFile({ name: 'image.img', size: 2048 })).toEqual({ format: 'raw' });
  });

  it('rejette une extension inconnue', () => {
    expect(() => validateUserMediaFile({ name: 'archive.zip', size: 2048 })).toThrow(
      /Extensions acceptées/,
    );
  });

  it('rejette un fichier vide', () => {
    expect(() => validateUserMediaFile({ name: 'vide.img', size: 0 })).toThrow(/vide/);
  });

  it('rejette un fichier au-dessus du plafond', () => {
    expect(() =>
      validateUserMediaFile({ name: 'enorme.img', size: MAX_USER_MEDIA_BYTES + 1 }),
    ).toThrow(/maximale/);
  });
});

describe('useUserMediaStore.importFor', () => {
  it('importe un média valide et le persiste localement', async () => {
    const store = createMemoryUserMediaStore();
    getStoreMock.mockResolvedValue(store);

    await useUserMediaStore.getState().importFor(system, makeFile('windows10.iso', 4096), true);

    const record = useUserMediaStore.getState().records[system.id];
    expect(record?.format).toBe('iso');
    expect(record?.size).toBe(4096);
    expect(await store.get(system.id)).toEqual(record);
    expect(await store.getBytes(system.id)).not.toBeNull();
    expect(useUserMediaStore.getState().error).toBeUndefined();
  });

  it('refuse l’import sans attestation de licence, sans toucher au stockage', async () => {
    await expect(
      useUserMediaStore.getState().importFor(system, makeFile('windows10.iso', 4096), false),
    ).rejects.toMatchObject({ code: 'ASSET_IMPORT_REJECTED' });

    expect(useUserMediaStore.getState().error).toMatch(/licence/i);
    expect(useUserMediaStore.getState().importing).toBe(false);
    expect(getStoreMock).not.toHaveBeenCalled();
  });

  it('refuse une extension inconnue avec un message actionnable', async () => {
    await expect(
      useUserMediaStore.getState().importFor(system, makeFile('archive.zip', 4096), true),
    ).rejects.toMatchObject({ code: 'ASSET_IMPORT_REJECTED' });

    expect(useUserMediaStore.getState().error).toContain('.iso');
    expect(getStoreMock).not.toHaveBeenCalled();
  });

  it('refuse un média trop volumineux sans lire les octets', async () => {
    await expect(
      useUserMediaStore
        .getState()
        .importFor(system, fileLike('enorme.img', MAX_USER_MEDIA_BYTES + 1), true),
    ).rejects.toMatchObject({ code: 'ASSET_IMPORT_REJECTED' });

    expect(useUserMediaStore.getState().error).toMatch(/maximale/);
    expect(getStoreMock).not.toHaveBeenCalled();
  });

  it('refuse l’import quand le quota local est insuffisant', async () => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { estimate: vi.fn(async () => ({ quota: 1000, usage: 900 })) },
    });

    await expect(
      useUserMediaStore.getState().importFor(system, makeFile('windows10.img', 4096), true),
    ).rejects.toMatchObject({ code: 'ASSET_CACHE_QUOTA_EXCEEDED' });

    expect(useUserMediaStore.getState().error).toMatch(/insuffisant/i);
    expect(getStoreMock).not.toHaveBeenCalled();
  });

  it('signale un manifeste JSON illisible', async () => {
    const manifest = {
      name: 'manifest.json',
      text: async () => '{ ceci n’est pas du JSON',
    } as unknown as File;
    await expect(
      useUserMediaStore
        .getState()
        .importFor(system, makeFile('windows10.img', 4096), true, manifest),
    ).rejects.toMatchObject({ code: 'ASSET_INVALID_MANIFEST' });
    expect(useUserMediaStore.getState().error).toMatch(/JSON invalide/);
  });

  it('rejette un manifeste dont la référence ne correspond pas au système', async () => {
    const manifest = {
      name: 'manifest.json',
      text: async () =>
        JSON.stringify({
          version: 1,
          ref: 'autre-systeme',
          displayName: 'Autre',
          format: 'raw',
          architecture: 'i386',
          license: 'x',
          provenance: 'y',
        }),
    } as unknown as File;
    await expect(
      useUserMediaStore
        .getState()
        .importFor(system, makeFile('windows10.img', 4096), true, manifest),
    ).rejects.toMatchObject({ code: 'ASSET_INVALID_MANIFEST' });
    expect(useUserMediaStore.getState().error).toMatch(/référence/i);
  });
});

describe('useUserMediaStore.remove', () => {
  it('supprime le média du stockage local et de l’état', async () => {
    const store = createMemoryUserMediaStore();
    getStoreMock.mockResolvedValue(store);
    await useUserMediaStore.getState().importFor(system, makeFile('windows10.iso', 2048), true);

    await useUserMediaStore.getState().remove(system.id);

    expect(useUserMediaStore.getState().records[system.id]).toBeUndefined();
    expect(await store.get(system.id)).toBeNull();
    expect(await store.getBytes(system.id)).toBeNull();
  });
});
