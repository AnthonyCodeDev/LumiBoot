import { useEffect, useState } from 'react';
import type { DownloadsManifest } from '../../config/downloads';
import { listDownloadTargets, loadDownloadsManifest } from '../../config/downloads';
import {
  detectHostPlatform,
  detectHostPlatformAsync,
  type HostPlatform,
  type PlatformKey,
} from '../../lib/platform';

export interface NetworkProxyDownloadProps {
  /** Plateforme injectée en test (sinon détection automatique). */
  platform?: HostPlatform | undefined;
  /** Manifeste injecté en test (sinon chargement réseau). */
  manifest?: DownloadsManifest | undefined;
}

/** Libellés lisibles des cibles, dans l'ordre du manifeste. */
const TARGET_LABELS: Record<PlatformKey, string> = {
  'windows-x64': 'Windows x64',
  'windows-arm64': 'Windows ARM64',
  'linux-x64': 'Linux x64',
  'linux-arm64': 'Linux ARM64',
  macos: 'macOS',
};

/**
 * Lien texte discret « Installer » vers le proxy réseau local de la plateforme
 * hôte, accompagné d'un bouton « voir toutes les versions » qui déplie la
 * liste de toutes les plateformes du manifeste.
 *
 * Tout passe par le manifeste (`/downloads/manifest.json`) : aucune URL en
 * dur, et une cible n'est cliquable que si `published === true && url`.
 */
export function NetworkProxyDownload(props: NetworkProxyDownloadProps) {
  const [platform, setPlatform] = useState<HostPlatform | null>(props.platform ?? null);
  const [manifest, setManifest] = useState<DownloadsManifest | null>(props.manifest ?? null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (props.platform !== undefined || props.manifest !== undefined) return;
    let cancelled = false;
    // Détection synchrone immédiate (UA), puis affinement asynchrone (userAgentData).
    setPlatform(detectHostPlatform());
    void (async () => {
      try {
        const detected = await detectHostPlatformAsync();
        if (!cancelled) setPlatform(detected);
      } catch {
        // Le repli synchrone déjà affiché suffit.
      }
      try {
        const loaded = await loadDownloadsManifest();
        if (!cancelled) setManifest(loaded);
      } catch {
        // Manifeste indisponible : aucun lien affiché.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.platform, props.manifest]);

  if (!manifest) return null;
  const targets = listDownloadTargets(manifest);
  const primary = platform?.key
    ? targets.find((target) => target.key === platform.key)
    : undefined;

  return (
    <>
      <div className="proxy-install-row">
        {primary?.url ? (
          <a href={primary.url} target="_blank" rel="noopener noreferrer">
            Installer
          </a>
        ) : null}
        <button
          type="button"
          className="proxy-versions-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'masquer les versions' : 'voir toutes les versions'}
        </button>
      </div>
      {expanded ? (
        <ul className="proxy-targets">
          {targets.map((target) => (
            <li key={target.key}>
              {target.url ? (
                <a href={target.url} target="_blank" rel="noopener noreferrer">
                  {TARGET_LABELS[target.key]}
                </a>
              ) : (
                <span aria-disabled="true">{TARGET_LABELS[target.key]} · Bientôt disponible</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
