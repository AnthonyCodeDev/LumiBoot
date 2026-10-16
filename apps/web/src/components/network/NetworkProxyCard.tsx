import { useEffect, useState } from 'react';
import { useProxyStore } from '../../features/proxy/store';
import { loadProxySession } from '../../features/proxy/persistence';
import { resolveProxyConfig } from '../../config/runtime';
import type { DownloadsManifest } from '../../config/downloads';
import type { HostPlatform } from '../../lib/platform';
import { Button } from '../ui/Button';
import { NetworkProxyDownload } from './NetworkProxyDownload';

export interface NetworkProxyCardProps {
  platform?: HostPlatform | undefined;
  manifest?: DownloadsManifest | undefined;
}

/**
 * Carte « Internet via votre connexion » (rendu minimaliste) : un titre, une
 * description courte, un bouton « Appairer » (ou « Déconnecter » une fois
 * connecté) et une note discrète expliquant l'usage du proxy réseau local.
 *
 * Reprend les effets de l'ancien `NetworkProxyStatus` : `refresh()` au montage
 * et `cancelPairing()` au démontage (aucun poll d'appairage orphelin).
 */
export function NetworkProxyCard(props: NetworkProxyCardProps) {
  const state = useProxyStore((s) => s.state);
  const token = useProxyStore((s) => s.token);
  const userCode = useProxyStore((s) => s.userCode);
  const startPairing = useProxyStore((s) => s.startPairing);
  const revoke = useProxyStore((s) => s.revoke);
  const refresh = useProxyStore((s) => s.refresh);
  const cancelPairing = useProxyStore((s) => s.cancelPairing);

  const { url: proxyUrl } = resolveProxyConfig();

  // Détection de « déjà appairé » : session persistée et non expirée pour
  // l'URL courante. L'initialisation paresseuse évite un flash au montage.
  const [hasSession, setHasSession] = useState(() => loadProxySession(proxyUrl) !== null);
  useEffect(() => {
    setHasSession(loadProxySession(proxyUrl) !== null);
  }, [state, token, proxyUrl]);

  const connected = state === 'connected' && token !== null;
  const connecting = state === 'connecting';

  // Message neutre tant qu'une session persiste mais qu'on n'est pas connecté
  // (proxy relancé, etc.). Il disparaît dès le début d'un appairage. Aucun
  // message n'est affiché pour un échec sans session ni pour les états passifs.
  const alreadyPairedMessage =
    !connected && !connecting && hasSession
      ? 'Vous êtes déjà appairé. Relancez le proxy, ou cliquez sur le bouton ci-dessus pour lancer un nouvel appairage.'
      : null;

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Démontage : annuler toute surveillance d'appairage en cours.
  useEffect(() => () => cancelPairing(), [cancelPairing]);

  return (
    <section className="proxy-card" aria-label="Internet via votre connexion">
      <h2>Internet via votre connexion</h2>
      <p className="proxy-description">
        Faites profiter vos systèmes lancés de votre connexion Internet, directement dans le
        navigateur.
      </p>
      <div className="proxy-actions">
        {connected ? (
          <>
            <span className="proxy-connected">Connecté</span>
            <Button variant="ghost" type="button" onClick={() => void revoke()}>
              Déconnecter
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            type="button"
            disabled={connecting}
            onClick={() => void startPairing()}
          >
            {connecting ? 'Appairage…' : 'Appairer'}
          </Button>
        )}
      </div>
      {connected ? (
        <p className="proxy-note">Votre connexion est partagée avec vos systèmes.</p>
      ) : (
        <div className="proxy-note">
          LumiBoot Network Proxy fait le lien entre vos systèmes et votre connexion.{' '}
          <NetworkProxyDownload platform={props.platform} manifest={props.manifest} />
        </div>
      )}
      {state === 'pairing-required' && userCode ? (
        <p className="proxy-note" role="status">
          En attente d’autorisation…
        </p>
      ) : null}
      {alreadyPairedMessage ? (
        <p className="proxy-note" role="status">
          {alreadyPairedMessage}
        </p>
      ) : null}
    </section>
  );
}
