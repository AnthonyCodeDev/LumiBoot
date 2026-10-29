const VERSION_LENGTH = 12;

/** Hash-derived `v` param: a distinct cache key, so no stale range serves old bytes. */
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
