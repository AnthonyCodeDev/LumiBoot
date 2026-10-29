const VERSION_LENGTH = 12;

/**
 * Adds a hash-derived `v` parameter to a boot media URL. Its only purpose is to
 * give a different cache key per build: a browser HTTP cache can otherwise answer
 * a Range request for the same path with bytes from an earlier version of the
 * file, which an initramfs then reads as a corrupt disk or initrd.
 * URLs without `sha256` (imported blob media, OPFS disks) are returned untouched.
 */
export function versionedMediaUrl(url: string, sha256?: string): string {
  if (!sha256) return url;
  const version = sha256.slice(0, VERSION_LENGTH).toLowerCase();
  if (!version) return url;
  const fragmentIndex = url.indexOf('#');
  const base = fragmentIndex === -1 ? url : url.slice(0, fragmentIndex);
  const fragment = fragmentIndex === -1 ? '' : url.slice(fragmentIndex);
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}v=${version}${fragment}`;
}
