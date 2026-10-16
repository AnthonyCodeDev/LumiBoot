import type { OSDefinition } from '@lumiboot/contracts';
import type { SessionSnapshot, VMState } from '@lumiboot/vm-core';
import { Button } from '../ui/Button';
import { engineShortLabels, getPrimaryLaunchProfile } from '../../lib/labels';
import { resolveNetworkProfile } from '../../config/runtime';
import { useSessionsStore } from '../../features/sessions/sessions.store';

/** États pendant lesquels une demande d'arrêt a du sens. */
const STOPPABLE: readonly VMState[] = ['preparing', 'downloading', 'booting', 'running'];

export interface SessionToolbarProps {
  session: SessionSnapshot;
  system: OSDefinition;
  onStop: () => void;
  onRestart: () => void;
  transitioning?: boolean;
  isFullscreen?: boolean;
  onToggleFullscreen?: (() => void) | undefined;
  logsOpen?: boolean;
  onToggleLogs?: (() => void) | undefined;
}

export function SessionToolbar({
  session,
  system,
  onStop,
  onRestart,
  transitioning = false,
  isFullscreen = false,
  onToggleFullscreen,
  logsOpen = false,
  onToggleLogs,
}: SessionToolbarProps) {
  const launchProfile = getPrimaryLaunchProfile(system);
  const canStop = STOPPABLE.includes(session.state);
  // Mode réseau **effectivement utilisé au démarrage** de la session (mémorisé
  // par le store au `boot`, ex. `local-proxy` par sélection automatique),
  // et non le mode configuré. Repli sur le mode configuré si la session n'est
  // pas encore enregistrée, puis silencieux hors runtime chargé (tests
  // unitaires) : aucun crash.
  const effectiveMode = useSessionsStore((s) => s.networkModes[session.id]);
  let networkMode: string | null = null;
  try {
    networkMode = effectiveMode ?? resolveNetworkProfile(system.id).mode;
  } catch {
    networkMode = effectiveMode ?? null;
  }

  return (
    <div className="session-toolbar" data-state={session.state} data-session-id={session.id}>
      <div className="session-toolbar-left">
        <img src={system.iconUrl} alt="" />
        <div className="session-title">
          <h1>{system.displayName}</h1>
          <p>
            {system.versionLabel} · {engineShortLabels[launchProfile.engineId]}
          </p>
        </div>
      </div>
      <div className="session-actions">
        {networkMode ? (
          <span className="session-network-badge" data-testid="session-network-mode">
            Réseau : {networkMode}
          </span>
        ) : null}
        {onToggleFullscreen ? (
          <Button
            variant="outline"
            type="button"
            onClick={onToggleFullscreen}
            aria-pressed={isFullscreen}
            title={
              isFullscreen ? 'Quitter le plein écran (Échap)' : 'Afficher la session en plein écran'
            }
          >
            {isFullscreen ? 'Quitter le plein écran' : 'Plein écran'}
          </Button>
        ) : null}
        {onToggleLogs ? (
          <Button
            variant="outline"
            type="button"
            onClick={onToggleLogs}
            aria-pressed={logsOpen}
            title={logsOpen ? 'Masquer les logs' : 'Afficher les logs'}
          >
            Logs
          </Button>
        ) : null}
        <Button
          variant="outline"
          type="button"
          onClick={onStop}
          disabled={transitioning || !canStop}
        >
          Arrêter
        </Button>
        <Button variant="primary" type="button" onClick={onRestart} disabled={transitioning}>
          Redémarrer
        </Button>
      </div>
    </div>
  );
}
