/**
 * Détection de la plateforme hôte pour le téléchargement du compagnon.
 *
 * Règles strictes : on ne suppose JAMAIS qu'un Mac est ARM64 ni qu'un
 * Windows est AMD64. Si l'architecture est indéterminée, `arch` vaut
 * `'unknown'` et `key` vaut `null` (l'UI demande alors à l'utilisateur de
 * choisir explicitement).
 *
 * Clés de plateforme (alignées sur `public/downloads/manifest.json`) :
 * `windows-x64`, `windows-arm64`, `macos`, `linux-x64`, `linux-arm64`.
 * macOS n'a qu'une seule clé (`macos`, binaire universel) quelle que soit
 * l'architecture détectée.
 */

export type HostOS = 'windows' | 'macos' | 'linux' | 'unknown';
export type HostArch = 'x64' | 'arm64' | 'unknown';
export type PlatformKey = 'windows-x64' | 'windows-arm64' | 'macos' | 'linux-x64' | 'linux-arm64';

export interface HostPlatform {
  os: HostOS;
  arch: HostArch;
  key: PlatformKey | null;
}

/** Sous-ensemble de `Navigator` utile à la détection (injectable en test). */
export interface HostNavigator {
  readonly userAgent?: string;
  readonly userAgentData?: {
    getHighEntropyValues?: (hints: string[]) => Promise<Record<string, string | undefined>>;
  } & Record<string, unknown>;
}

function resolveNavigator(nav?: HostNavigator): HostNavigator | undefined {
  if (nav !== undefined) return nav;
  if (typeof navigator !== 'undefined') return navigator as unknown as HostNavigator;
  return undefined;
}

function detectOS(userAgent: string): HostOS {
  const ua = userAgent.toLowerCase();
  if (ua.includes('windows')) return 'windows';
  if (ua.includes('mac os x') || ua.includes('macintosh') || ua.includes('macos')) return 'macos';
  // Android contient « linux » : ce n'est pas un hôte bureau supporté.
  if (ua.includes('android')) return 'unknown';
  if (ua.includes('linux')) return 'linux';
  return 'unknown';
}

/**
 * Détecte l'architecture depuis le seul userAgent.
 *
 * Sur macOS, les Mac Apple Silicon envoient historiquement
 * `Macintosh; Intel Mac OS X …` pour compatibilité : « Intel » ne prouve donc
 * rien sur l'architecture réelle. On renvoie toujours `unknown` pour macOS
 * dans le chemin synchrone (seul `detectHostPlatformAsync` via
 * `userAgentData` peut lever l'ambiguïté).
 */
function detectArchFromUA(userAgent: string, os: HostOS): HostArch {
  const ua = userAgent.toLowerCase();
  const hasArm =
    ua.includes('arm64') || ua.includes('aarch64') || /(^|[\s;()])arm([\s;()-]|$)/.test(ua);
  if (hasArm) return 'arm64';
  if (os === 'macos') return 'unknown';
  const hasX64 =
    ua.includes('x86_64') ||
    ua.includes('x64') ||
    ua.includes('amd64') ||
    ua.includes('win64') ||
    ua.includes('wow64');
  if (hasX64) return 'x64';
  return 'unknown';
}

function keyFor(os: HostOS, arch: HostArch): PlatformKey | null {
  if (os === 'macos') return 'macos';
  if (os === 'windows' && arch === 'x64') return 'windows-x64';
  if (os === 'windows' && arch === 'arm64') return 'windows-arm64';
  if (os === 'linux' && arch === 'x64') return 'linux-x64';
  if (os === 'linux' && arch === 'arm64') return 'linux-arm64';
  return null;
}

/**
 * Détection synchrone (repli `userAgent` uniquement).
 *
 * Pure et testable : passez un faux navigateur `{ userAgent }` en test.
 */
export function detectHostPlatform(nav?: HostNavigator): HostPlatform {
  const resolved = resolveNavigator(nav);
  const userAgent = resolved?.userAgent ?? '';
  const os = detectOS(userAgent);
  const arch = os === 'unknown' ? 'unknown' : detectArchFromUA(userAgent, os);
  return { os, arch, key: keyFor(os, arch) };
}

/**
 * Détection asynchrone : utilise `navigator.userAgentData.getHighEntropyValues`
 * (`architecture`, `platform`) quand disponible, sinon repli synchrone.
 *
 * Correspondances `architecture` Chromium : `arm` → `arm64`, `x86` → `x64`
 * (les navigateurs renvoient `x86` y compris sur x86_64). Toute autre valeur
 * → `unknown` (aucune supposition). `platform` Chromium : `Windows`,
 * `macOS`, `Linux` (et `Android`/`Chrome OS` → `unknown`).
 */
export async function detectHostPlatformAsync(nav?: HostNavigator): Promise<HostPlatform> {
  const resolved = resolveNavigator(nav);
  const getValues = resolved?.userAgentData?.getHighEntropyValues;
  if (typeof getValues === 'function') {
    try {
      const values = await getValues.call(resolved?.userAgentData, ['architecture', 'platform']);
      const platform = (values?.['platform'] ?? '').toLowerCase();
      const architecture = (values?.['architecture'] ?? '').toLowerCase();
      const os: HostOS = platform.includes('windows')
        ? 'windows'
        : platform.includes('macos') || platform.includes('mac')
          ? 'macos'
          : platform === 'linux'
            ? 'linux'
            : 'unknown';
      let arch: HostArch = 'unknown';
      if (architecture.includes('arm')) arch = 'arm64';
      else if (architecture.includes('x86') || architecture.includes('64')) arch = 'x64';
      if (os !== 'unknown') return { os, arch, key: keyFor(os, arch) };
    } catch {
      // Repli synchrone ci-dessous (API refusée ou indisponible).
    }
  }
  return detectHostPlatform(resolved);
}
