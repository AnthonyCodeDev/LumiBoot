import { describe, expect, it } from 'vitest';
import { versionedMediaUrl } from './media-url';

describe('versionedMediaUrl', () => {
  it('appends a hash-derived version to a plain boot media URL', () => {
    expect(versionedMediaUrl('/images/ubuntu-18-i386/rootfs.img', '86c8889052118606')).toBe(
      '/images/ubuntu-18-i386/rootfs.img?v=86c888905211',
    );
  });

  it('leaves the URL untouched when no digest is known', () => {
    expect(versionedMediaUrl('/images/local/disk.img')).toBe('/images/local/disk.img');
    expect(versionedMediaUrl('/images/local/disk.img', '')).toBe('/images/local/disk.img');
  });

  it('extends an existing query instead of replacing it', () => {
    expect(versionedMediaUrl('/images/debian/initrd.img?raw=1', 'abcdef0123456789')).toBe(
      '/images/debian/initrd.img?raw=1&v=abcdef012345',
    );
  });

  it('lowercases the digest and keeps the full URL otherwise intact', () => {
    expect(versionedMediaUrl('/images/debian/vmlinuz-686', 'ABCDEF0123456789')).toBe(
      '/images/debian/vmlinuz-686?v=abcdef012345',
    );
  });

  it('inserts the parameter before a fragment', () => {
    expect(versionedMediaUrl('/images/debian/disk.img#boot', 'abcdef0123456789')).toBe(
      '/images/debian/disk.img?v=abcdef012345#boot',
    );
  });
});
