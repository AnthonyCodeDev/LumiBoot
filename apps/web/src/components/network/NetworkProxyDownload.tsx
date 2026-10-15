import { useEffect, useState } from 'react';
import type { DownloadsManifest } from '../../config/downloads';
import { listDownloadTargets, loadDownloadsManifest } from '../../config/downloads';
import {
  detectHostPlatform,
  detectHostPlatformAsync,
  type HostPlatform,
  type PlatformKey,
} from '../../lib/platform';
import { Button } from '../ui/Button';

const OS_DOWNLOAD_LABEL: Record<string, string> = {
  windows: 'Télécharger pour Windows',
  macos: 'Télécharger pour macOS',
  linux: 'Télécharger pour Linux',
};

const TARGET_LABEL: Record<PlatformKey, string> = {
  'windows-x64': 'Windows x64',
  'windows-arm64': 'Windows ARM64',
  'linux-x64': 'Linux x64',
  'linux-arm64': 'Linux ARM64',
  macos: 'macOS (universel)',
};

export interface NetworkProxyDownloadProps {
  /** Plateforme injectée en test (sinon détection automatique). */
  platform?: HostPlatform | undefined;
  /** Manifeste injecté en test (sinon chargement réseau). */
  manifest?: DownloadsManifest | undefined;
}

function primaryLabel(platform: HostPlatform | null): string {
  if (!platform || platform.os === 'unknown') return 'Télécharger le proxy réseau local';
  return OS_DOWNLOAD_LABEL[platform.os] ?? 'Télécharger le proxy réseau local';
}

/**
 * Bouton de téléchargement du proxy réseau local.
 *
 * Tout passe par le manifeste (`/downloads/manifest.json`) : aucune URL en
 * dur. Chaque cible n'est cliquable que si `published === true && url`.
 * macOS non signé : l'avertissement n'apparaît que si macOS est la plateforme
 * pertinente (détectée/choisie ou liste « Autres plateformes » dépliée).
 */
export function NetworkProxyDownload(props: NetworkProxyDownloadProps) {
  const [platform, setPlatform] = useState<HostPlatform | null>(props.platform ?? null);
  const [manifest, setManifest] = useState<DownloadsManifest | null>(props.manifest ?? null);
  const [loading, setLoading] = useState(props.manifest !== undefined ? false : true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

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
        if (!cancelled) {
          setManifest(loaded);
          setLoadError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : 'Téléchargements indisponibles.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.platform, props.manifest]);

  if (loading) {
    return <p className="proxy-hint">Chargement des téléchargements…</p>;
  }
  if (!manifest) {
    return (
      <p className="proxy-hint" role="status">
        {loadError ?? 'Téléchargements indisponibles pour le moment.'}
      </p>
    );
  }

  const targets = listDownloadTargets(manifest);
  const primaryKey = platform?.key ?? null;
  const primary = primaryKey ? targets.find((t) => t.key === primaryKey) : undefined;
  const macosEntry = manifest.platforms['macos'];
  const macosUnsigned = macosEntry.published && macosEntry.signed === false;
  // L'avertissement macOS n'est contextuel : plateforme pertinente ou liste dépliée.
  const showMacosWarning = macosUnsigned && (primaryKey === 'macos' || showAll);

  return (
    <div className="proxy-download">
      {primary?.url ? (
        <Button
          variant="primary"
          type="button"
          onClick={() => window.open(primary.url as string, '_blank', 'noopener')}
        >
          {primaryLabel(platform)}
        </Button>
      ) : primary && !primary.url ? (
        <div className="proxy-download-primary">
          <Button variant="primary" type="button" disabled>
            {primaryLabel(platform)}
          </Button>
          <p className="proxy-hint">Bientôt disponible pour {TARGET_LABEL[primary.key]}</p>
        </div>
      ) : (
        <div className="proxy-download-primary">
          <p className="proxy-hint">
            Votre système n’a pas pu être détecté : choisissez votre plateforme ci-dessous.
          </p>
        </div>
      )}
      {showMacosWarning ? (
        <p className="proxy-warning" role="note">
          Version macOS non signée et non notariée : macOS affichera un avertissement (clic droit →
          Ouvrir) et l’archive doit être vérifiée avant usage. Ce n’est pas une application
          installable sans avertissement.
        </p>
      ) : null}
      <button
        type="button"
        className="proxy-others-toggle"
        onClick={() => setShowAll((v) => !v)}
        aria-expanded={showAll}
      >
        {showAll ? 'Masquer les autres plateformes' : 'Autres plateformes'}
      </button>
      {showAll ? (
        <ul className="proxy-targets">
          {targets.map(({ key, entry, url }) => {
            const label =
              key === 'macos' && entry.signed === false
                ? `${TARGET_LABEL[key]} (non signé)`
                : TARGET_LABEL[key];
            return (
              <li key={key}>
                {url ? (
                  <a href={url} target="_blank" rel="noopener noreferrer">
                    {label} — {entry.file}
                  </a>
                ) : (
                  <span aria-disabled="true">
                    {label} — {entry.file} · Bientôt disponible
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
