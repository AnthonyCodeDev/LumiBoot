import type { OSDefinition } from '@lumiboot/contracts';
import type { SessionSnapshot } from '@lumiboot/vm-core';
import { getPrimaryLaunchProfile } from '../../lib/labels';

export interface StatusOverlayProps {
  session: SessionSnapshot;
  system: OSDefinition;
}

export function StatusOverlay({ session, system }: StatusOverlayProps) {
  const launchProfile = getPrimaryLaunchProfile(system);

  if (session.state === 'error') {
    return (
      <div className="status-overlay" role="alert">
        <span className="status-badge" data-tone="error">
          INDISPONIBLE
        </span>
        <h2>Session non disponible pour le moment.</h2>
        <p>{session.error?.message ?? 'Le moteur de ce système n’est pas encore prêt.'}</p>
        <p>
          {system.displayName} reste au statut « {system.availability} ». L&apos;écran apparaîtra
          lorsque le profil de lancement réel (<code>{launchProfile.engineId}</code>) pourra
          démarrer ce système.
        </p>
        {session.error ? (
          <p>
            Code : <code>{session.error.code}</code>
          </p>
        ) : null}
      </div>
    );
  }

  const label =
    session.state === 'running'
      ? 'Session active'
      : session.state === 'stopped'
        ? 'Session arrêtée'
        : 'Préparation de la session…';

  return (
    <div className="status-overlay">
      <span className="status-badge">{label.toUpperCase()}</span>
      <h2>{label}</h2>
      {session.phase ? <p>Phase : {session.phase}</p> : null}
    </div>
  );
}
