import { describe, expect, it } from 'vitest';
import { AssetError } from './errors';
import {
  createMemoryUserMediaStore,
  importUserMedia,
  parseUserMediaManifest,
  type UserMediaInput,
} from './user-media';

const HASH = 'a'.repeat(64);

const input: UserMediaInput = {
  ref: 'windows-7-x86',
  displayName: 'Windows 7 x86 (local media)',
  fileName: 'windows-7.img',
  format: 'raw',
  licenseAcknowledged: true,
};

const blobOf = (size: number): Blob => new Blob([new Uint8Array(size)]);

describe('parseUserMediaManifest', () => {
  it('accepts a valid user manifest', () => {
    const manifest = parseUserMediaManifest({
      version: 1,
      ref: 'windows-7-x86',
      displayName: 'Windows 7 x86',
      format: 'raw',
      architecture: 'i386',
      sha256: HASH,
      sizeBytes: 1024,
      license: 'Retail license held by the user',
      provenance: 'Personal disk',
    });
    expect(manifest.ref).toBe('windows-7-x86');
    expect(manifest.sha256).toBe(HASH);
  });

  it('rejects an invalid reference', () => {
    expect(() =>
      parseUserMediaManifest({
        version: 1,
        ref: 'Windows 7',
        displayName: 'Windows 7',
        format: 'raw',
        architecture: 'i386',
        license: 'x',
        provenance: 'y',
      }),
    ).toThrow(AssetError);
  });

  it('rejects a non-hexadecimal checksum', () => {
    expect(() =>
      parseUserMediaManifest({
        version: 1,
        ref: 'windows-7-x86',
        displayName: 'Windows 7',
        format: 'raw',
        architecture: 'i386',
        sha256: 'zz',
        license: 'x',
        provenance: 'y',
      }),
    ).toThrow(AssetError);
  });
});

describe('importUserMedia', () => {
  it('rejects the import without a license acknowledgement', async () => {
    const store = createMemoryUserMediaStore();
    await expect(
      importUserMedia(store, { ...input, licenseAcknowledged: false }, blobOf(16)),
    ).rejects.toMatchObject({ code: 'ASSET_IMPORT_REJECTED' });
  });

  it('marks a media without a reference checksum as "unverified"', async () => {
    const store = createMemoryUserMediaStore();
    const descriptor = await importUserMedia(store, input, blobOf(32));
    expect(descriptor.integrity).toBe('unverified');
    expect(descriptor.sha256).toBeUndefined();
    expect(await store.get('windows-7-x86')).toEqual(descriptor);
  });

  it('verifies the provided checksum and marks the media "verified"', async () => {
    const store = createMemoryUserMediaStore();
    const descriptor = await importUserMedia(store, input, blobOf(64), {
      expectedSha256: HASH,
      hash: async () => HASH,
    });
    expect(descriptor.integrity).toBe('verified');
    expect(descriptor.sha256).toBe(HASH.toLowerCase());
  });

  it('rejects a mismatching checksum', async () => {
    const store = createMemoryUserMediaStore();
    await expect(
      importUserMedia(store, input, blobOf(64), {
        expectedSha256: HASH,
        hash: async () => 'b'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'ASSET_CHECKSUM_MISMATCH' });
  });

  it('rejects a mismatching size', async () => {
    const store = createMemoryUserMediaStore();
    await expect(
      importUserMedia(store, input, blobOf(64), { expectedSize: 128 }),
    ).rejects.toMatchObject({ code: 'ASSET_SIZE_MISMATCH' });
  });

  it('does not hash beyond the cap and stays "unverified"', async () => {
    const store = createMemoryUserMediaStore();
    let hashed = false;
    const descriptor = await importUserMedia(store, input, blobOf(1024), {
      expectedSha256: HASH,
      maxHashBytes: 10,
      hash: async () => {
        hashed = true;
        return HASH;
      },
    });
    expect(hashed).toBe(false);
    expect(descriptor.integrity).toBe('unverified');
  });

  it('keeps the bytes and can read them back / delete them', async () => {
    const store = createMemoryUserMediaStore();
    await importUserMedia(store, input, blobOf(128));
    const bytes = await store.getBytes('windows-7-x86');
    expect(bytes?.size).toBe(128);
    await store.remove('windows-7-x86');
    expect(await store.get('windows-7-x86')).toBeNull();
    expect(await store.getBytes('windows-7-x86')).toBeNull();
    expect(await store.list()).toEqual([]);
  });
});
