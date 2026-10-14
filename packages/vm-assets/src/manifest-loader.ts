import { z } from 'zod';
import { AssetError } from './errors';
import { getImageManifest, registerImageManifest, type ImageManifest } from './manifest';

const HEX64 = /^[0-9a-f]{64}$/i;
const IMAGE_REF = /^[a-z0-9-]+$/;

/**
 * Validation stricte du manifeste d'image servi en statique.
 *
 * Refuse toute URL absolue (accès réseau inattendu), tout SHA non hexadécimal
 * de 64 caractères, toute taille non positive et tout manifeste incomplet : un
 * manifeste invalide fait échouer le démarrage au lieu de produire une session
 * incohérente.
 */
export const imageFileRefSchema = z.object({
  url: z
    .string()
    .min(1)
    .regex(/^\/images\//, 'URL relative attendue sous « /images/ »'),
  sha256: z.string().regex(HEX64, 'SHA-256 hexadécimal de 64 caractères attendu'),
  size: z.number().int().positive(),
  version: z.string().min(1).optional(),
});

export const imageBootOptionsSchema = z
  .object({
    cmdline: z.string().min(1).optional(),
    wasmPath: z.string().min(1).optional(),
    biosUrl: z.string().min(1).optional(),
    vgaBiosUrl: z.string().min(1).optional(),
  })
  .strict();

export const imageManifestSchema = z
  .object({
    ref: z.string().regex(IMAGE_REF, 'référence : minuscules, chiffres et tirets'),
    architecture: z.enum(['i386', 'x86', 'x86_64', 'arm', 'arm64', 'powerpc', 'm68k']),
    memoryMiB: z.number().int().positive(),
    vgaMemoryMiB: z.number().int().positive().optional(),
    license: z.string().min(1),
    files: z
      .object({
        disk: imageFileRefSchema,
        bzimage: imageFileRefSchema,
        initrd: imageFileRefSchema,
      })
      .catchall(imageFileRefSchema),
    boot: imageBootOptionsSchema.optional(),
  })
  .strict();

/** Promesses de chargement en vol, pour dédupliquer les appels concurrents. */
const inflight = new Map<string, Promise<ImageManifest>>();

/**
 * Garantit qu'un manifeste est enregistré, puis le retourne.
 *
 * Ne récupère jamais les octets du disque : le manifeste est petit, le disque
 * est lu par v86 via HTTP Range. Un manifeste déjà enregistré n'est pas
 * rechargé (le rechargement d'une nouvelle version se fait en vidant le
 * registre via `clearImageManifests()`).
 */
export async function ensureImageManifest(
  ref: string,
  signal?: AbortSignal,
): Promise<ImageManifest> {
  const known = getImageManifest(ref);
  if (known) return known;

  const pending = inflight.get(ref);
  if (pending) return pending;

  const task = loadImageManifest(ref, signal).finally(() => {
    inflight.delete(ref);
  });
  inflight.set(ref, task);
  return task;
}

export async function loadImageManifest(ref: string, signal?: AbortSignal): Promise<ImageManifest> {
  if (!IMAGE_REF.test(ref)) {
    throw new AssetError('ASSET_INVALID_MANIFEST', 'Référence d’image invalide.', { ref });
  }

  let response: Response;
  try {
    response = await fetch(`/images/${ref}/manifest.json`, {
      signal: signal ?? null,
      cache: 'no-cache',
    });
  } catch (error) {
    if (signal?.aborted) {
      throw new AssetError('ASSET_ABORTED', 'Chargement du manifeste annulé.', {
        ref,
        cause: error,
      });
    }
    throw new AssetError('ASSET_NOT_FOUND', 'Manifeste inaccessible.', { ref, cause: error });
  }

  if (!response.ok) {
    throw new AssetError('ASSET_NOT_FOUND', `Manifeste HTTP ${response.status}.`, { ref });
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    throw new AssetError('ASSET_INVALID_MANIFEST', 'Manifeste JSON illisible.', {
      ref,
      cause: error,
    });
  }

  const parsed = imageManifestSchema.safeParse(json);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'manifeste'} : ${issue.message}`)
      .join(' ; ');
    throw new AssetError('ASSET_INVALID_MANIFEST', `Manifeste invalide — ${details}`, { ref });
  }

  const manifest = parsed.data as unknown as ImageManifest;
  if (manifest.ref !== ref) {
    throw new AssetError(
      'ASSET_INVALID_MANIFEST',
      'La référence du manifeste diffère de la demande.',
      {
        ref,
      },
    );
  }

  registerImageManifest(manifest);
  return manifest;
}
