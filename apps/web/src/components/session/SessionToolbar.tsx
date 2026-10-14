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
}

export function SessionToolbar({
  session,
  system,
  onStop,
  onRestart,
  transitioning = false,
}: SessionToolbarProps) {
  const launchProfile = getPrimaryLaunchProfile(system);
  const canStop = STOPPABLE.includes(session.state);

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
          {STATE_LABELS[session.state]}
        </span>
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
