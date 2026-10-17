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

// ---------------------------------------------------------------------------
// Requêtes partagées (déduplication)
// ---------------------------------------------------------------------------

/**
 * Entrée de registre : une seule requête en vol par clé, partagée par tous les
 * consommateurs. Chaque consommateur possède son propre signal d'annulation ;
 * la requête sous-jacente utilise un signal interne qui N'EST JAMAIS celui d'un
 * consommateur.
 */
interface SharedRequestEntry<V> {
  readonly promise: Promise<V>;
  readonly controller: AbortController;
  /** Nombre de consommateurs encore intéressés (ref-count). */
  consumers: number;
}

export interface SharedRequestRegistry<V> {
  /**
   * Rejoint ou démarre la requête partagée associée à `key`.
   *
   * L'annulation d'un consommateur ne rejette QUE sa promesse : la requête
   * sous-jacente continue tant qu'un autre consommateur l'attend. Elle n'est
   * interrompue que lorsque TOUS les consommateurs ont annulé. Un rejet (échec)
   * n'est jamais mis en cache : la prochaine demande relance une requête.
   */
  run(
    key: string,
    signal: AbortSignal | undefined,
    load: (signal: AbortSignal) => Promise<V>,
  ): Promise<V>;
  /** Nombre de requêtes actuellement en vol (diagnostic / tests). */
  pending(): number;
  /** Interrompt et oublie toutes les requêtes en vol (tests). */
  clear(): void;
}

/**
 * Construit un registre de requêtes dédupliquées, isolant l'annulation par
 * consommateur (`ref-count`) du signal interne de la requête.
 *
 * @param createAbortError fabrique l'erreur renvoyée à un consommateur annulé.
 */
export function createSharedRequestRegistry<V>(
  createAbortError: (cause?: unknown) => Error,
): SharedRequestRegistry<V> {
  const entries = new Map<string, SharedRequestEntry<V>>();

  /** Libère un consommateur ; interrompt la requête si plus personne n'attend. */
  function release(key: string, entry: SharedRequestEntry<V>): void {
    entry.consumers -= 1;
    if (entry.consumers <= 0 && !entry.controller.signal.aborted) {
      // Requête abandonnée par TOUS : on l'interrompt ET on la retire
      // immédiatement pour qu'un appel ultérieur reparte sur une requête
      // neuve (une annulation collective n'est jamais un échec caché).
      entry.controller.abort();
      if (entries.get(key) === entry) entries.delete(key);
    }
  }

  return {
    run(key, signal, load) {
      // Un signal déjà annulé ne déclenche AUCUNE requête (et ne rejoint pas
      // une requête existante) : le consommateur est immédiatement annulé.
      if (signal?.aborted) {
        return Promise.reject(createAbortError());
      }

      let entry = entries.get(key);
      if (entry === undefined) {
        const controller = new AbortController();
        const created: SharedRequestEntry<V> = {
          controller,
          consumers: 0,
          // La requête interne NE reçoit jamais le signal d'un consommateur :
          // l'annulation du premier demandeur ne peut donc pas casser les autres.
          promise: Promise.resolve().then(() => load(controller.signal)),
        };
        // Un échec n'est jamais conservé : l'entrée disparaît dès qu'elle est
        // réglée, quelle qu'en soit l'issue (succès ou rejet).
        void created.promise
          .finally(() => {
            if (entries.get(key) === created) entries.delete(key);
          })
          .catch(() => undefined);
        entries.set(key, created);
        entry = created;
      }

      const current = entry;
      current.consumers += 1;

      if (signal === undefined) {
        return current.promise.finally(() => release(key, current));
      }

      return new Promise<V>((resolve, reject) => {
        let settled = false;
        // Toute sortie retire le listener : aucun `AbortSignal` ne fuit.
        const onAbort = (): void => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          release(key, current);
          reject(createAbortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        current.promise.then(
          (value) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            release(key, current);
            resolve(value);
          },
          (error: unknown) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            release(key, current);
            reject(error);
          },
        );
      });
    },
    pending: () => entries.size,
    clear() {
      for (const entry of entries.values()) entry.controller.abort();
      entries.clear();
    },
  };
}

/** Registre partagé des manifestes d'images. */
const imageManifestRequests = createSharedRequestRegistry<ImageManifest>(
  () => new AssetError('ASSET_ABORTED', 'Chargement du manifeste annulé.'),
);

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

  return imageManifestRequests.run(ref, signal, (requestSignal) =>
    loadImageManifest(ref, requestSignal),
  );
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
      headers: { Accept: 'application/json' },
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

  if (readHeader(response, 'content-type').includes('text/html')) {
    throw new AssetError(
      'ASSET_INVALID_MANIFEST',
      'Le serveur a renvoyé du HTML (repli SPA) au lieu d’un manifeste JSON.',
      { ref },
    );
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
    throw new AssetError(
      'ASSET_INVALID_MANIFEST',
      `Manifeste invalide — ${formatIssues(parsed.error)}`,
      { ref },
    );
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

// ---------------------------------------------------------------------------
// Disponibilité des assets (manifeste + disque réellement servable)
// ---------------------------------------------------------------------------

/** Motif stable d'indisponibilité, destiné à l'UI et aux diagnostics. */
export type AssetUnavailableReason =
  | 'ref-invalid'
  | 'manifest-missing'
  | 'manifest-html'
  | 'manifest-invalid'
  | 'manifest-schema'
  | 'ref-mismatch'
  | 'disk-missing'
  | 'disk-html'
  | 'disk-mismatch'
  | 'range-unsupported'
  | 'unauthorized'
  | 'network'
  | 'aborted';

/** Résultat d'une vérification de disponibilité d'asset. */
export interface AssetAvailability {
  readonly ref: string;
  readonly available: boolean;
  readonly reason?: AssetUnavailableReason;
  readonly message?: string;
  /** Taille totale annoncée par le serveur (`Content-Range`), si connue. */
  readonly size?: number;
}

export interface AssetAvailabilityOptions {
  readonly signal?: AbortSignal;
  /** Implémentation `fetch` injectable (tests) ; `globalThis.fetch` par défaut. */
  readonly fetchImpl?: typeof fetch;
}

interface RangeProbeOptions extends AssetAvailabilityOptions {
  readonly expectedSize?: number;
}

/** Lit un en-tête quelle que soit l'implémentation (`Headers` ou objet nu). */
function readHeader(response: Response, name: string): string {
  const headers = response.headers as unknown;
  if (headers === null || typeof headers !== 'object') return '';
  if (typeof (headers as { get?: unknown }).get === 'function') {
    return String((headers as Headers).get(name) ?? '');
  }
  const record = headers as Record<string, string | undefined>;
  const value = record[name] ?? record[name.toLowerCase()];
  return value === undefined ? '' : String(value);
}

/** Annule le corps d'une réponse non lue (évite de télécharger un disque entier). */
function discardBody(response: Response): void {
  const body = response.body as ReadableStream<Uint8Array> | null | undefined;
  if (body !== null && body !== undefined && typeof body.cancel === 'function') {
    void body.cancel().catch(() => undefined);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'manifeste'} : ${issue.message}`)
    .join(' ; ');
}

function resolveFetch(options: AssetAvailabilityOptions): typeof fetch {
  const resolved = options.fetchImpl ?? globalThis.fetch;
  if (typeof resolved !== 'function') {
    throw new AssetError('ASSET_NOT_FOUND', 'fetch est indisponible dans cet environnement.');
  }
  return resolved;
}

function unavailable(
  reason: AssetUnavailableReason,
  message: string,
): Omit<AssetAvailability, 'ref'> {
  return { available: false, reason, message };
}

type JsonDocumentResult =
  | { readonly kind: 'json'; readonly json: unknown }
  | {
      readonly kind: 'unavailable';
      readonly reason: AssetUnavailableReason;
      readonly message: string;
    };

/**
 * Récupère un document JSON en distinguant explicitement les causes d'échec :
 * 404, repli HTML d'une SPA (au lieu de JSON), JSON illisible ou erreur réseau.
 */
export async function fetchJsonDocument(
  url: string,
  options: AssetAvailabilityOptions = {},
): Promise<JsonDocumentResult> {
  const fetchImpl = resolveFetch(options);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      cache: 'no-cache',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    if (options.signal?.aborted) {
      return { kind: 'unavailable', reason: 'aborted', message: 'Requête annulée.' };
    }
    return {
      kind: 'unavailable',
      reason: 'network',
      message: `Manifeste inaccessible : ${describeError(error)}.`,
    };
  }

  if (response.status === 404) {
    discardBody(response);
    return {
      kind: 'unavailable',
      reason: 'manifest-missing',
      message: 'Manifeste absent (HTTP 404).',
    };
  }
  if (readHeader(response, 'content-type').includes('text/html')) {
    discardBody(response);
    return {
      kind: 'unavailable',
      reason: 'manifest-html',
      message: 'Le serveur a renvoyé du HTML (repli SPA) au lieu d’un manifeste JSON.',
    };
  }
  if (!response.ok) {
    discardBody(response);
    return {
      kind: 'unavailable',
      reason: 'manifest-missing',
      message: `Manifeste HTTP ${response.status}.`,
    };
  }

  try {
    return { kind: 'json', json: await response.json() };
  } catch (error) {
    return {
      kind: 'unavailable',
      reason: 'manifest-invalid',
      message: `Manifeste JSON illisible : ${describeError(error)}.`,
    };
  }
}

/**
 * Vérifie qu'une URL est bien servie en HTTP Range (206 + `Content-Range`),
 * condition REQUISE par v86 (`hda.async`). Un serveur qui répond 200 à une
 * requête Range renvoie le fichier entier : on annule immédiatement le corps et
 * on signale clairement l'absence de support Range.
 */
export async function probeRangeAvailability(
  url: string,
  options: RangeProbeOptions = {},
): Promise<Omit<AssetAvailability, 'ref'>> {
  const fetchImpl = resolveFetch(options);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0', 'X-Accept-Encoding': 'identity' },
      cache: 'no-store',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    if (options.signal?.aborted) {
      return unavailable('aborted', 'Requête disque annulée.');
    }
    return unavailable('network', `Disque inaccessible : ${describeError(error)}.`);
  }

  const contentType = readHeader(response, 'content-type');

  if (response.status === 404) {
    discardBody(response);
    return unavailable('disk-missing', 'Disque absent (HTTP 404).');
  }

  if (response.status === 200) {
    discardBody(response);
    if (contentType.includes('text/html')) {
      return unavailable(
        'disk-html',
        'Le serveur a renvoyé du HTML (repli SPA) au lieu du disque.',
      );
    }
    return unavailable(
      'range-unsupported',
      'Le serveur ignore Range (HTTP 200 au lieu de 206) : v86 ne peut pas lire le disque par plages.',
    );
  }

  if (response.status === 206) {
    const contentRange = readHeader(response, 'content-range');
    const match = /\/(\d+)\s*$/.exec(contentRange);
    discardBody(response);
    if (match === null) {
      return unavailable(
        'range-unsupported',
        'Réponse 206 sans « Content-Range » exploitable : la lecture par plages est indéterminée.',
      );
    }
    const size = Number(match[1]);
    if (options.expectedSize !== undefined && size !== options.expectedSize) {
      return {
        available: false,
        reason: 'disk-mismatch',
        message: `Taille du disque incohérente : ${size} octets servis, ${options.expectedSize} attendus.`,
        size,
      };
    }
    return { available: true, size };
  }

  if (response.status === 401 || response.status === 403) {
    discardBody(response);
    return unavailable('unauthorized', `Accès au disque refusé (HTTP ${response.status}).`);
  }

  discardBody(response);
  return unavailable('network', `Réponse disque inattendue (HTTP ${response.status}).`);
}

/**
 * Vérifie qu'une image publiée est réellement utilisable : manifeste JSON valide
 * au schéma, référence cohérente, puis disque servi en HTTP Range (206).
 */
export async function checkImageAvailability(
  ref: string,
  options: AssetAvailabilityOptions = {},
): Promise<AssetAvailability> {
  if (!IMAGE_REF.test(ref)) {
    return { ref, ...unavailable('ref-invalid', 'Référence d’image invalide.') };
  }

  const document = await fetchJsonDocument(`/images/${ref}/manifest.json`, options);
  if (document.kind === 'unavailable') {
    return { ref, ...unavailable(document.reason, document.message) };
  }

  const parsed = imageManifestSchema.safeParse(document.json);
  if (!parsed.success) {
    return {
      ref,
      ...unavailable('manifest-schema', `Manifeste invalide — ${formatIssues(parsed.error)}`),
    };
  }
  if (parsed.data.ref !== ref) {
    return {
      ref,
      ...unavailable('ref-mismatch', 'La référence du manifeste diffère de la demande.'),
    };
  }

  const probe = await probeRangeAvailability(parsed.data.files.disk.url, {
    ...options,
    expectedSize: parsed.data.files.disk.size,
  });
  return { ref, ...probe };
}
