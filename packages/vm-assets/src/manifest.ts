import type { Architecture, OSDefinition } from '@lumiboot/contracts';
import { AssetError } from './errors';

export interface ImageFileRef {
  url: string;
  sha256: string;
  size: number;
  version?: string;
}

/**
 * Paramètres de démarrage propres à une image, optionnels. Ils permettent de
 * faire varier les chemins des binaires du moteur et la ligne de commande du
 * noyau sans modifier le code du provider.
 */
export interface ImageBootOptions {
  cmdline?: string;
  wasmPath?: string;
  biosUrl?: string;
  vgaBiosUrl?: string;
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
    throw new AssetError('ASSET_INVALID_MANIFEST', 'Le manifeste doit avoir une référence.', {
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
    throw new AssetError('ASSET_NOT_FOUND', `Aucune image n'est associée à « ${os.id} ».`, {
      ref: os.id,
    });
  }
  const manifest = getImageManifest(os.imageRef);
  if (!manifest) {
    throw new AssetError('ASSET_NOT_FOUND', `Image « ${os.imageRef} » introuvable.`, {
      ref: os.imageRef,
    });
  }
  return manifest;
}
