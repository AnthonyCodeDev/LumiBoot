import { useCompanionStore } from '../../features/companion/store';
import type { DownloadsManifest } from '../../config/downloads';
import type { HostPlatform } from '../../lib/platform';
import { NetworkCompanionDownload } from './NetworkCompanionDownload';
import { NetworkCompanionStatus } from './NetworkCompanionStatus';

export interface NetworkCompanionCardProps {
  platform?: HostPlatform | undefined;
  manifest?: DownloadsManifest | undefined;
}

/**
 * Carte « Internet via votre connexion » : téléchargement + état réel du
 * compagnon + étapes. Masque les instructions d'installation quand l'état est
 * `connected` (avec token).
 */
export function NetworkCompanionCard(props: NetworkCompanionCardProps) {
  const state = useCompanionStore((s) => s.state);
  const token = useCompanionStore((s) => s.token);
  const connected = state === 'connected' && token !== null;

  return (
    <section className="companion-card" aria-label="Internet via votre connexion">
      <h2>Internet via votre connexion</h2>
      <p className="companion-description">
        Installez LumiBoot Network Companion pour permettre aux systèmes d&apos;exploitation
        d&apos;utiliser directement votre connexion Internet.
      </p>
      <NetworkCompanionDownload platform={props.platform} manifest={props.manifest} />
      <NetworkCompanionStatus />
      {!connected ? (
        <ol className="companion-steps">
          <li>Téléchargez le compagnon pour votre plateforme.</li>
          <li>Installez-le puis lancez-le sur cette machine.</li>
          <li>Revenez sur cette page et cliquez sur « Connecter ».</li>
        </ol>
      ) : (
        <p className="companion-hint">
          Compagnon connecté : vos sessions peuvent utiliser votre connexion.
        </p>
      )}
    </section>
  );
}
