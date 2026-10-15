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

export interface NetworkCompanionDownloadProps {
  /** Plateforme injectée en test (sinon détection automatique). */
  platform?: HostPlatform | undefined;
  /** Manifeste injecté en test (sinon chargement réseau). */
  manifest?: DownloadsManifest | undefined;
}

function primaryLabel(platform: HostPlatform | null): string {
  if (!platform || platform.os === 'unknown') return 'Télécharger le compagnon';
  return OS_DOWNLOAD_LABEL[platform.os] ?? 'Télécharger le compagnon';
}

/**
 * Bouton de téléchargement du compagnon.
 *
 * Tout passe par le manifeste (`/downloads/manifest.json`) : aucune URL en
 * dur. Chaque cible n'est cliquable que si `published === true && url`.
 * macOS non signé : avertissement explicite, jamais présenté comme une app
 * installable sans avertissement.
 */
export function NetworkCompanionDownload(props: NetworkCompanionDownloadProps) {
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
    return <p className="companion-hint">Chargement des téléchargements…</p>;
  }
  if (!manifest) {
    return (
      <p className="companion-hint" role="status">
        {loadError ?? 'Téléchargements indisponibles pour le moment.'}
      </p>
    );
  }

  const targets = listDownloadTargets(manifest);
  const primaryKey = platform?.key ?? null;
  const primary = primaryKey ? targets.find((t) => t.key === primaryKey) : undefined;
  const macosEntry = manifest.platforms['macos'];
  const macosUnsigned = macosEntry.published && macosEntry.signed === false;

  return (
    <div className="companion-download">
      {primary?.url ? (
        <Button
          variant="primary"
          type="button"
          onClick={() => window.open(primary.url as string, '_blank', 'noopener')}
        >
          {primaryLabel(platform)}
        </Button>
      ) : primary && !primary.url ? (
        <div className="companion-download-primary">
          <Button variant="primary" type="button" disabled>
            {primaryLabel(platform)}
          </Button>
          <p className="companion-hint">Bientôt disponible pour {TARGET_LABEL[primary.key]}</p>
        </div>
      ) : (
        <div className="companion-download-primary">
          <p className="companion-hint">
            Votre système n’a pas pu être détecté : choisissez votre plateforme ci-dessous.
          </p>
        </div>
      )}
      {macosUnsigned ? (
        <p className="companion-warning" role="note">
          Version macOS non signée et non notariée : macOS affichera un avertissement (clic droit →
          Ouvrir) et l’archive doit être vérifiée avant usage. Ce n’est pas une application
          installable sans avertissement.
        </p>
      ) : null}
      <button
        type="button"
        className="companion-others-toggle"
        onClick={() => setShowAll((v) => !v)}
        aria-expanded={showAll}
      >
        {showAll ? 'Masquer les autres plateformes' : 'Autres plateformes'}
      </button>
      {showAll ? (
        <ul className="companion-targets">
          {targets.map(({ key, entry, url }) => (
            <li key={key}>
              {url ? (
                <a href={url} target="_blank" rel="noopener noreferrer">
                  {TARGET_LABEL[key]} — {entry.file}
                </a>
              ) : (
                <span aria-disabled="true">
                  {TARGET_LABEL[key]} — {entry.file} · Bientôt disponible
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
