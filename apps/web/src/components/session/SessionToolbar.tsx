import type { OSDefinition } from '@lumiboot/contracts';
import type { SessionSnapshot } from '@lumiboot/vm-core';
import { Button } from '../ui/Button';
import { engineLabels } from '../../lib/labels';

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

export interface SessionToolbarProps {
  session: SessionSnapshot;
  system: OSDefinition;
  onStop: () => void;
  onRestart: () => void;
}

export function SessionToolbar({ session, system, onStop, onRestart }: SessionToolbarProps) {
  const busy = session.state === 'preparing' || session.state === 'booting' || session.state === 'running';

  return (
    <div className="session-toolbar">
      <div className="session-toolbar-left">
        <img src={system.iconUrl} alt="" />
        <div className="session-title">
          <h1>{system.displayName}</h1>
          <p>
            {system.versionLabel} · {engineLabels[system.engineId]} · provider « {session.providerId} »
          </p>
        </div>
      </div>
      <div className="session-actions">
        <span className="session-state" data-state={session.state}>
          {STATE_LABELS[session.state]}
        </span>
        <Button variant="outline" type="button" onClick={onStop} disabled={!busy && session.state !== 'booting'}>
          Arrêter
        </Button>
        <Button variant="primary" type="button" onClick={onRestart}>
          Redémarrer
        </Button>
      </div>
    </div>
  );
}
