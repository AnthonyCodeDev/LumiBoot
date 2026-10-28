import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

/**
 * Build/CI guardrail for the public webroot, for P2 security.
 *
 * The published webroot, `apps/web/public/` then `apps/web/dist/`, must NEVER
 * contain a proprietary system image such as Windows media, nor user media. Free
 * distribution disks such as Debian and Ubuntu stay allowed: this guardrail must
 * not break free Linux images.
 */

const repoRoot = process.cwd();

/** Free image references allowed in the public webroot. */
const ALLOWED_IMAGE_REFS = [/^alpine-/i, /^debian-/i, /^ubuntu-/i];

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

/** User media: never publishable in the static webroot. */
const USER_MEDIA_SUFFIXES = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm', '.vob', '.m4v']);

const PROPRIETARY_MEDIA = /windows|winxp|winvista|win(?:7|8|10|11)/i;

export interface WebrootViolation {
  path: string;
  reason: string;
}

/**
 * Detects forbidden media in a list of paths relative to an `images/` folder:
 * proprietary system names, user media, or non-free disks.
 */
export function findForbiddenWebrootMedia(relativePaths: string[]): WebrootViolation[] {
  const violations: WebrootViolation[] = [];
  for (const rawPath of relativePaths) {
    const path = rawPath.replace(/\\/g, '/');
    const suffix = extname(path).toLowerCase();
    if (PROPRIETARY_MEDIA.test(path)) {
      violations.push({ path, reason: 'proprietary system media' });
      continue;
    }
    if (USER_MEDIA_SUFFIXES.has(suffix)) {
      violations.push({ path, reason: `forbidden user media "${suffix}"` });
      continue;
    }
    if (!DISK_SUFFIXES.has(suffix)) continue;
    const segments = path.split('/').filter(Boolean);
    const reference = (segments[0] ?? '').toLowerCase();
    if (!ALLOWED_IMAGE_REFS.some((pattern) => pattern.test(reference))) {
      violations.push({ path, reason: `non-free disk "${suffix}" under "${reference}"` });
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

describe('public webroot guardrail', () => {
  it('flags a Windows disk and allows free Alpine, Debian and Ubuntu disks', () => {
    const violations = findForbiddenWebrootMedia([
      'windows-7-pro-sp1-x86/disk.img',
      'debian-12-i386/rootfs.img',
      'debian-12-i386/initrd.img',
      'debian-12-i386/manifest.json',
      'ubuntu-18-i386/rootfs.img',
      'ubuntu-18-i386/manifest.json',
      'alpine-3-24-x86-64/alpine-virt-3.24.0-x86_64.iso',
    ]);
    // Only the proprietary Windows disk is a violation.
    expect(violations).toHaveLength(1);
    expect(violations[0]?.path).toBe('windows-7-pro-sp1-x86/disk.img');
  });

  it('flags a non-free disk under an unknown reference', () => {
    const violations = findForbiddenWebrootMedia(['msdos/disk.qcow2']);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain('.qcow2');
  });

  it('flags user media inside the webroot', () => {
    const violations = findForbiddenWebrootMedia([
      'debian-12-i386/our-film.mp4',
      'upload/video.mkv',
    ]);
    expect(violations).toHaveLength(2);
  });

  it('real public/dist webroot: no proprietary media, Debian allowed', () => {
    const roots = [
      join(repoRoot, 'apps', 'web', 'public', 'images'),
      join(repoRoot, 'apps', 'web', 'dist', 'images'),
    ];
    const violations = roots.flatMap((root) => findForbiddenWebrootMedia(listRelativeFiles(root)));
    expect(violations).toEqual([]);
  });
});
