import type { OSDefinition } from '@lumiboot/contracts';
import type { SessionSnapshot } from '@lumiboot/vm-core';
import { getPrimaryLaunchProfile } from '../../lib/labels';
import {
  STEPS,
  formatSessionBytes,
  statusMessageForSession,
  statusTextForSession,
  stepIndexForState,
} from './statusOverlay.helpers';

export interface StatusOverlayProps {
  session: SessionSnapshot;
  system: OSDefinition;
}

export function StatusOverlay({ session, system }: StatusOverlayProps) {
  const launchProfile = getPrimaryLaunchProfile(system);

  if (session.state === 'error') {
    const mediaRequired = session.error?.code === 'MEDIA_REQUIRED';
    return (
      <div className="status-overlay" role="alert">
        <span className="status-badge" data-tone="error">
          {mediaRequired ? 'RESSOURCE REQUISE' : 'INDISPONIBLE'}
        </span>
        <h2>
          {mediaRequired ? 'Média système manquant.' : 'Session non disponible pour le moment.'}
        </h2>
        <p>{session.error?.message ?? 'Le moteur de ce système n’est pas encore prêt.'}</p>
        {mediaRequired ? (
          <p>
            Retournez à la fiche de {system.displayName} pour importer un média que vous détenez
            légalement. Aucune image n’est fournie par LumiBoot.
          </p>
        ) : (
          <p>
            {system.displayName} reste au statut « {system.availability} ». L’écran apparaîtra
            lorsque le profil de lancement réel (<code>{launchProfile.engineId}</code>) pourra
            démarrer ce système.
          </p>
        )}
        {session.error ? (
          <p>
            Code : <code>{session.error.code}</code>
          </p>
        ) : null}
      </div>
    );
  }

  if (session.state === 'stopping' || session.state === 'stopped' || session.state === 'idle') {
    const message = statusMessageForSession(session);
    return (
      <div
        className="status-overlay"
        role="status"
        aria-live="polite"
        aria-busy={session.state === 'stopping'}
      >
        <div className="session-progress session-progress--message" data-state={session.state}>
          <p className="session-progress-eyebrow">Session</p>
          <h2 className="session-progress-title">{message.title}</h2>
          {message.detail ? <p className="session-progress-detail">{message.detail}</p> : null}
          {session.state === 'stopping' ? (
            <span className="session-message-indicator" aria-hidden="true">
              <span className="session-message-dot" />
              <span className="session-message-dot" />
              <span className="session-message-dot" />
            </span>
          ) : null}
        </div>
      </div>
    );
  }

  const statusText = statusTextForSession(session);
  const loadedBytes = session.loadedBytes ?? 0;
  const totalBytes = session.totalBytes ?? 0;
  const hasTotal = totalBytes > 0;
  const ratio = hasTotal ? Math.min(Math.max(loadedBytes / totalBytes, 0), 1) : 0;
  const percent = Math.round(ratio * 100);
  const currentStep =
    session.state === 'running' ? STEPS.length - 1 : stepIndexForState(session.state);
  const progressAriaText = hasTotal
    ? `${percent} % · ${formatSessionBytes(loadedBytes)} sur ${formatSessionBytes(totalBytes)}`
    : statusText;

  return (
    <div className="status-overlay" role="status" aria-live="polite">
      <div className="session-progress">
        <header className="session-progress-heading">
          <p className="session-progress-eyebrow">Session en cours</p>
          <h2 className="session-progress-title">{statusText}</h2>
        </header>

        <ol className="session-steps" aria-label="Progression de la session">
          {STEPS.map((label, index) => {
            const status =
              index < currentStep ? 'done' : index === currentStep ? 'current' : 'upcoming';
            return (
              <li
                key={label}
                className="session-steps-item"
                data-status={status}
                aria-current={status === 'current' ? 'step' : undefined}
              >
                <span className="session-steps-marker" aria-hidden="true">
                  {status === 'done' ? (
                    <svg className="session-steps-check" viewBox="0 0 16 16">
                      <path d="M4.5 8.5 7 11l4.5-5.5" />
                    </svg>
                  ) : status === 'current' ? (
                    <span className="session-steps-core" />
                  ) : null}
                </span>
                <span className="session-steps-label">{label}</span>
              </li>
            );
          })}
        </ol>

        <div
          className="session-progress-bar"
          role="progressbar"
          aria-label="Progression du téléchargement"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={hasTotal ? percent : undefined}
          aria-valuetext={progressAriaText}
        >
          <div className="session-progress-track">
            <div
              className={
                hasTotal
                  ? 'session-progress-fill'
                  : 'session-progress-fill session-progress-fill--indeterminate'
              }
              style={hasTotal ? { width: `${percent}%` } : undefined}
            />
          </div>
          {hasTotal ? (
            <div className="session-progress-meta">
              <span className="session-progress-percent">{percent} %</span>
              <span className="session-progress-bytes">
                {formatSessionBytes(loadedBytes)} / {formatSessionBytes(totalBytes)}
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
