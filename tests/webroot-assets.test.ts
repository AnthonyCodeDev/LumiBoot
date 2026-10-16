import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

/**
 * Garde-fou build/CI du webroot public (P2 sécurité).
 *
 * Le webroot publié (`apps/web/public/` puis `apps/web/dist/`) ne doit JAMAIS
 * contenir d'image système propriétaire (Windows…) ni de média utilisateur. Les
 * disques de distributions libres (Debian) restent autorisés : ce garde-fou ne
 * doit pas casser les images Linux libres.
 */

const repoRoot = process.cwd();

/** Références d'images libres autorisées dans le webroot public. */
const ALLOWED_IMAGE_REFS = [/^debian-/i];

const DISK_SUFFIXES = new Set([
  '.img',
  '.iso',
  '.qcow',
  '.qcow2',
  '.vhd',
  '.vhdx',
  '.vmdk',
  '.vdi',
  '.raw',
]);

/** Médias utilisateur : jamais publiables dans le webroot statique. */
const USER_MEDIA_SUFFIXES = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm', '.vob', '.m4v']);

const PROPRIETARY_MEDIA = /windows|winxp|winvista|win(?:7|8|10|11)/i;

export interface WebrootViolation {
  path: string;
  reason: string;
}

/**
 * Détecte, dans une liste de chemins relatifs à un dossier `images/`, les
 * médias interdits : noms de systèmes propriétaires, médias utilisateur, ou
 * disques non libres.
 */
export function findForbiddenWebrootMedia(relativePaths: string[]): WebrootViolation[] {
  const violations: WebrootViolation[] = [];
  for (const rawPath of relativePaths) {
    const path = rawPath.replace(/\\/g, '/');
    const suffix = extname(path).toLowerCase();
    if (PROPRIETARY_MEDIA.test(path)) {
      violations.push({ path, reason: 'média de système propriétaire' });
      continue;
    }
    if (USER_MEDIA_SUFFIXES.has(suffix)) {
      violations.push({ path, reason: `média utilisateur « ${suffix} » interdit` });
      continue;
    }
    if (!DISK_SUFFIXES.has(suffix)) continue;
    const segments = path.split('/').filter(Boolean);
    const reference = (segments[0] ?? '').toLowerCase();
    if (!ALLOWED_IMAGE_REFS.some((pattern) => pattern.test(reference))) {
      violations.push({ path, reason: `disque non libre « ${suffix} » sous « ${reference} »` });
    }
  }
  return violations;
}

function listRelativeFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && statSync(full).isFile()) files.push(relative(root, full));
    }
  };
  walk(root);
  return files;
}

describe('garde-fou webroot public', () => {
  it('signale un disque Windows et autorise un disque Debian', () => {
    const violations = findForbiddenWebrootMedia([
      'windows-7-pro-sp1-x86/disk.img',
      'debian-12-i386/rootfs.img',
      'debian-12-i386/initrd.img',
      'debian-12-i386/manifest.json',
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.path).toBe('windows-7-pro-sp1-x86/disk.img');
  });

  it('signale un disque non libre sous une référence inconnue', () => {
    const violations = findForbiddenWebrootMedia(['msdos/disk.qcow2']);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain('.qcow2');
  });

  it('signale un média utilisateur dans le webroot', () => {
    const violations = findForbiddenWebrootMedia([
      'debian-12-i386/mon-film.mp4',
      'upload/video.mkv',
    ]);
    expect(violations).toHaveLength(2);
  });

  it('webroot public/dist réel : aucun média propriétaire, Debian autorisé', () => {
    const roots = [
      join(repoRoot, 'apps', 'web', 'public', 'images'),
      join(repoRoot, 'apps', 'web', 'dist', 'images'),
    ];
    const violations = roots.flatMap((root) => findForbiddenWebrootMedia(listRelativeFiles(root)));
    expect(violations).toEqual([]);
  });
});
