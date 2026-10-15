import { useEffect } from 'react';
import type { CompanionState } from '@lumiboot/vm-network';
import { useCompanionStore } from '../../features/companion/store';
import { resolveCompanionConfig } from '../../config/runtime';
import { Button } from '../ui/Button';

const STATE_LABELS: Record<CompanionState, string> = {
  'not-installed': 'Non installé',
  'not-running': 'Compagnon arrêté',
  'permission-required': 'Permission d’accès réseau requise',
  'pairing-required': 'En attente d’appairage',
  connecting: 'Connexion en cours…',
  connected: 'Connecté',
  error: 'Erreur de connexion',
  incompatible: 'Version incompatible',
};

const STATE_TONE: Record<CompanionState, 'ok' | 'warn' | 'bad' | 'idle'> = {
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
 * Affiche l'état réel du compagnon (`CompanionState`) avec une action
 * contextuelle. N'affiche « Connecté » que sur état `connected` (store :
 * `/health` OK + token obtenu) — aucune réussite fictive.
 */
export function NetworkCompanionStatus() {
  const state = useCompanionStore((s) => s.state);
  const token = useCompanionStore((s) => s.token);
  const userCode = useCompanionStore((s) => s.userCode);
  const error = useCompanionStore((s) => s.error);
  const refresh = useCompanionStore((s) => s.refresh);
  const startPairing = useCompanionStore((s) => s.startPairing);
  const connect = useCompanionStore((s) => s.connect);
  const revoke = useCompanionStore((s) => s.revoke);
  const companionUrl = resolveCompanionConfig().url;

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="companion-status" data-state={state} data-tone={STATE_TONE[state]}>
      <span className="companion-status-dot" aria-hidden="true" />
      <div className="companion-status-body">
        <strong>{state === 'connected' && token ? 'Connecté' : STATE_LABELS[state]}</strong>
        {state === 'not-running' ? (
          <p>
            Lancez LumiBoot Network Companion sur cette machine ({companionUrl}), puis réessayez.
          </p>
        ) : null}
        {state === 'permission-required' ? (
          <p>
            Votre navigateur bloque l’accès au réseau local. Autorisez l’accès au réseau local pour
            ce site, puis réessayez.
          </p>
        ) : null}
        {state === 'pairing-required' && userCode ? (
          <p>
            Code d’appairage : <code>{userCode}</code> — validez-le depuis la page d’admin locale du
            compagnon, puis cliquez sur « Connecter ».
          </p>
        ) : null}
        {state === 'pairing-required' && !userCode ? (
          <p>Compagnon joint. Lancez l’appairage pour obtenir un jeton de session.</p>
        ) : null}
        {state === 'incompatible' ? (
          <p>
            Le compagnon joint parle un protocole inattendu (WISP v1 requis). Mettez à jour le
            compagnon.
          </p>
        ) : null}
        {state === 'error' && error ? <p role="alert">{error}</p> : null}
        {state === 'connected' ? (
          <p>Les systèmes en mode « compagnon local » peuvent utiliser votre connexion.</p>
        ) : null}
      </div>
      <div className="companion-status-actions">
        {state === 'connected' ? (
          <Button variant="outline" type="button" onClick={() => void revoke()}>
            Révoquer
          </Button>
        ) : null}
        {state === 'pairing-required' ? (
          <Button variant="primary" type="button" onClick={() => void connect()}>
            Connecter
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
