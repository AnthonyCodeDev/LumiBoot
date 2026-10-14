import type { OSDefinition } from '@lumiboot/contracts';
import type { SessionSnapshot, VMState } from '@lumiboot/vm-core';
import { Button } from '../ui/Button';
import { getPrimaryLaunchProfile, launchProfileLabel } from '../../lib/labels';

const STATE_LABELS: Record<SessionSnapshot['state'], string> = {
  idle: 'Inactif',
  preparing: 'Préparation',
  downloading: 'Téléchargement',
  booting: 'Démarrage',
  running: 'En cours',
  stopping: 'Arrêt',
  stopped: 'Arrêté',
  error: 'Erreur',
};

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
  const totalBytes = session.totalBytes ?? 0;
  const loadedBytes = session.loadedBytes ?? 0;
  const hasProgress = session.state === 'downloading' && totalBytes > 0;
  const progressPercent = hasProgress
    ? Math.round(Math.min(Math.max(loadedBytes / totalBytes, 0), 1) * 100)
    : null;
  const stateLabel =
    progressPercent !== null
      ? `${STATE_LABELS[session.state]} · ${progressPercent} %`
      : STATE_LABELS[session.state];

  return (
    <div className="session-toolbar">
      <div className="session-toolbar-left">
        <img src={system.iconUrl} alt="" />
        <div className="session-title">
          <h1>{system.displayName}</h1>
          <p>
            {system.versionLabel} · {launchProfileLabel(launchProfile)} · provider «{' '}
            {session.providerId} »
          </p>
        </div>
      </div>
      <div className="session-actions">
        <span className="session-state" data-state={session.state}>
          {stateLabel}
        </span>
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
