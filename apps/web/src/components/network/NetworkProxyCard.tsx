import { useProxyStore } from '../../features/proxy/store';
import type { DownloadsManifest } from '../../config/downloads';
import type { HostPlatform } from '../../lib/platform';
import { NetworkProxyDownload } from './NetworkProxyDownload';
import { NetworkProxyStatus } from './NetworkProxyStatus';

export interface NetworkProxyCardProps {
  platform?: HostPlatform | undefined;
  manifest?: DownloadsManifest | undefined;
}

/**
 * Carte « Internet via votre connexion » : téléchargement + état réel du
 * proxy réseau local + étapes. Masque les instructions d'installation quand
 * l'état est `connected` (avec token).
 */
export function NetworkProxyCard(props: NetworkProxyCardProps) {
  const state = useProxyStore((s) => s.state);
  const token = useProxyStore((s) => s.token);
  const connected = state === 'connected' && token !== null;

  return (
    <section className="proxy-card" aria-label="Internet via votre connexion">
      <h2>Internet via votre connexion</h2>
      <p className="proxy-description">
        Installez LumiBoot Network Proxy pour permettre aux systèmes d&apos;exploitation
        d&apos;utiliser directement votre connexion Internet.
      </p>
      <NetworkProxyDownload platform={props.platform} manifest={props.manifest} />
      <NetworkProxyStatus />
      {!connected ? (
        <ol className="proxy-steps">
          <li>Téléchargez le proxy réseau local pour votre plateforme.</li>
          <li>Installez-le puis lancez-le sur cette machine.</li>
          <li>Validez l’autorisation depuis la console du proxy : la connexion se fait toute seule.</li>
        </ol>
      ) : (
        <p className="proxy-hint">
          Proxy réseau local actif : vos sessions peuvent utiliser votre connexion.
        </p>
      )}
    </section>
  );
}
