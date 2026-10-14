import type { OSDefinition } from '@lumiboot/contracts';
import type { SessionSnapshot } from '@lumiboot/vm-core';
import { getPrimaryLaunchProfile } from '../../lib/labels';

export interface StatusOverlayProps {
  session: SessionSnapshot;
  system: OSDefinition;
}

const STEPS = ['Préparation', 'Téléchargement', 'Démarrage du noyau Debian', 'Système prêt'] as const;

function stepIndexForState(state: SessionSnapshot['state']): number {
  switch (state) {
    case 'preparing':
      return 0;
    case 'downloading':
      return 1;
    case 'booting':
      return 2;
    case 'running':
      return 3;
    default:
      return -1;
  }
}

function statusTextForSession(session: SessionSnapshot): string {
  switch (session.state) {
    case 'downloading':
      return 'Téléchargement des ressources…';
    case 'booting':
      return 'Démarrage du noyau Debian…';
    case 'running':
      return 'Système prêt.';
    case 'stopped':
      return 'Session arrêtée.';
    case 'stopping':
      return 'Arrêt de la session…';
    case 'preparing':
    case 'idle':
    default:
      return 'Préparation de la session…';
  }
}

export function formatSessionBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${Math.round(value)} o`;
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const rounded = size >= 100 ? Math.round(size).toString() : size.toFixed(1).replace('.', ',');
  return `${rounded} ${units[unitIndex]}`;
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

  const statusText = statusTextForSession(session);
  const loadedBytes = session.loadedBytes ?? 0;
  const totalBytes = session.totalBytes ?? 0;
  const hasTotal = totalBytes > 0;
  const ratio = hasTotal ? Math.min(Math.max(loadedBytes / totalBytes, 0), 1) : 0;
  const percent = Math.round(ratio * 100);
  const currentStep = session.state === 'running' ? STEPS.length - 1 : stepIndexForState(session.state);
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
