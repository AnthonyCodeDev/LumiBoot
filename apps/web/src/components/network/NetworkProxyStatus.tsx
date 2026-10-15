import { useEffect } from 'react';
import type { ProxyState } from '@lumiboot/vm-network';
import { useProxyStore } from '../../features/proxy/store';
import { resolveProxyConfig } from '../../config/runtime';
import { Button } from '../ui/Button';

const STATE_LABELS: Record<ProxyState, string> = {
  'not-installed': 'Proxy non installé',
  'not-running': 'Proxy réseau local arrêté',
  'permission-required': 'Permission réseau local requise',
  'pairing-required': 'En attente d’autorisation',
  connecting: 'Connexion au proxy…',
  connected: 'Proxy réseau local actif',
  error: 'Erreur du proxy réseau local',
  incompatible: 'Version du proxy incompatible',
};

const STATE_TONE: Record<ProxyState, 'ok' | 'warn' | 'bad' | 'idle'> = {
  'not-installed': 'idle',
  'not-running': 'idle',
  'permission-required': 'warn',
  'pairing-required': 'warn',
  connecting: 'idle',
  connected: 'ok',
  error: 'bad',
  incompatible: 'bad',
};

/**
 * Affiche l'état réel du proxy réseau local (`ProxyState`) avec une action
 * contextuelle. N'affiche l'état actif que sur `connected` (store : `/health`
 * OK **et** jeton validé par vérification authentifiée) — aucune réussite
 * fictive sur un simple `/health`. Après l'appairage, la connexion se fait
 * toute seule : aucun bouton « Connecter » à cliquer.
 */
export function NetworkProxyStatus() {
  const state = useProxyStore((s) => s.state);
  const token = useProxyStore((s) => s.token);
  const userCode = useProxyStore((s) => s.userCode);
  const error = useProxyStore((s) => s.error);
  const refresh = useProxyStore((s) => s.refresh);
  const startPairing = useProxyStore((s) => s.startPairing);
  const revoke = useProxyStore((s) => s.revoke);
  const cancelPairing = useProxyStore((s) => s.cancelPairing);
  const proxyUrl = resolveProxyConfig().url;

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Démontage : annuler toute surveillance d'appairage en cours (aucun poll
  // orphelin continuant en arrière-plan).
  useEffect(() => () => cancelPairing(), [cancelPairing]);

  return (
    <div className="proxy-status" data-state={state} data-tone={STATE_TONE[state]}>
      <span className="proxy-status-dot" aria-hidden="true" />
      <div className="proxy-status-body">
        <strong>{STATE_LABELS[state]}</strong>
        {state === 'not-running' ? (
          <p>Lancez LumiBoot Network Proxy sur cette machine ({proxyUrl}), puis réessayez.</p>
        ) : null}
        {state === 'permission-required' ? (
          <p>
            Votre navigateur bloque l’accès au réseau local. Autorisez l’accès au réseau local pour
            ce site, puis réessayez.
          </p>
        ) : null}
        {state === 'pairing-required' && userCode ? (
          <p>
            Code d’appairage : <code>{userCode}</code> — validez-le depuis la console du proxy. En
            attente d’autorisation…
          </p>
        ) : null}
        {state === 'pairing-required' && !userCode ? (
          <p>Proxy réseau local joint. Lancez l’appairage pour obtenir un jeton de session.</p>
        ) : null}
        {state === 'incompatible' ? (
          <p>
            Le proxy réseau local joint parle un protocole inattendu (WISP v1 requis). Mettez à jour
            le proxy réseau local.
          </p>
        ) : null}
        {state === 'error' && error ? <p role="alert">{error}</p> : null}
        {state === 'connected' ? (
          <p>Les systèmes en mode « proxy réseau local » peuvent utiliser votre connexion.</p>
        ) : null}
      </div>
      <div className="proxy-status-actions">
        {state === 'connected' && token ? (
          <Button variant="outline" type="button" onClick={() => void revoke()}>
            Révoquer
          </Button>
        ) : null}
        {state === 'not-running' ||
        state === 'permission-required' ||
        state === 'incompatible' ||
        state === 'error' ? (
          <Button variant="outline" type="button" onClick={() => void refresh()}>
            Réessayer
          </Button>
        ) : null}
        {state === 'error' ? (
          <Button variant="primary" type="button" onClick={() => void startPairing()}>
            Relancer l’appairage
          </Button>
        ) : null}
        {state === 'pairing-required' && !userCode ? (
          <Button variant="primary" type="button" onClick={() => void startPairing()}>
            Lancer l’appairage
          </Button>
        ) : null}
        {state === 'connecting' ? (
          <Button variant="outline" type="button" disabled>
            Connexion…
          </Button>
        ) : null}
      </div>
    </div>
  );
}
