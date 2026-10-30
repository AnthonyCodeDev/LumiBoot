import type { Architecture, OSDefinition } from '@lumiboot/contracts';
import { AssetError } from './errors';

export interface ImageFileRef {
  url: string;
  sha256: string;
  size: number;
  version?: string;
}

/** Varies engine paths and the kernel command line per image. */
export interface ImageBootOptions {
  cmdline?: string;
  wasmPath?: string;
  biosUrl?: string;
  vgaBiosUrl?: string;
  /**
   * The ISO carries its own bootloader: the guest boots from El-Torito, so no
   * bzimage/initrd is injected and the disk is only mounted as a CD-ROM.
   */
  cdromOnly?: boolean;
}

export interface ImageManifest {
  ref: string;
  architecture: Architecture;
  memoryMiB: number;
  vgaMemoryMiB?: number;
  files: Record<string, ImageFileRef>;
  license: string;
  boot?: ImageBootOptions;
}

const manifests = new Map<string, ImageManifest>();

export function registerImageManifest(manifest: ImageManifest): void {
  if (!manifest.ref) {
    throw new AssetError('ASSET_INVALID_MANIFEST', 'The manifest must have a reference.', {
      ref: manifest.ref,
    });
  }
  manifests.set(manifest.ref, manifest);
}

export function getImageManifest(ref: string): ImageManifest | null {
  return manifests.get(ref) ?? null;
}

export function clearImageManifests(): void {
  manifests.clear();
}

export function resolveImage(os: OSDefinition): ImageManifest {
  if (!os.imageRef) {
    throw new AssetError('ASSET_NOT_FOUND', `No image is associated with "${os.id}".`, {
      ref: os.id,
    });
  }
  const manifest = getImageManifest(os.imageRef);
  if (!manifest) {
    throw new AssetError('ASSET_NOT_FOUND', `Image "${os.imageRef}" not found.`, {
      ref: os.imageRef,
    });
  }
  return manifest;
}
