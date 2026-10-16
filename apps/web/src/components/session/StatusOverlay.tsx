import { useEffect, useState, type RefObject } from 'react';
import type { OSDefinition } from '@lumiboot/contracts';
import type { SessionSnapshot } from '@lumiboot/vm-core';
import { getPrimaryLaunchProfile } from '../../lib/labels';
import { statusMessageForSession, statusTextForSession } from './statusOverlay.helpers';

export interface StatusOverlayProps {
  session: SessionSnapshot;
  system: OSDefinition;
  /** Référence vers `.session-console`, qui contient le `textarea.v86-serial`. */
  consoleRef: RefObject<HTMLDivElement>;
}

/** Période de relecture du terminal série (ms). */
const SERIAL_POLL_MS = 400;
/** Nombre de lignes de log conservées à l'écran. */
const LOG_LINE_COUNT = 3;

/**
 * Dernières lignes non vides du terminal série de l'invité.
 * v86 écrit dans `.value` du `<textarea class="v86-serial">`, même masqué.
 */
function readSerialTail(container: HTMLElement | null): string[] {
  const serial = container?.querySelector<HTMLTextAreaElement>('textarea.v86-serial');
  const raw = serial?.value ?? '';
  return raw
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-LOG_LINE_COUNT);
}

interface SessionLogsProps {
  consoleRef: RefObject<HTMLDivElement>;
  fallback: string;
}

/**
 * Panneau de logs : les 3 dernières lignes du terminal, rafraîchies en polling
 * pour donner l'impression d'un défilement continu. Toujours au moins une ligne
 * (repli dérivé de l'état) pour ne jamais afficher un panneau vide.
 */
function SessionLogs({ consoleRef, fallback }: SessionLogsProps) {
  const [tail, setTail] = useState('');

  useEffect(() => {
    const read = () => {
      const next = readSerialTail(consoleRef.current).join('\n');
      setTail((prev) => (prev === next ? prev : next));
    };
    read();
    const timer = window.setInterval(read, SERIAL_POLL_MS);
    return () => window.clearInterval(timer);
  }, [consoleRef]);

  const lines = tail.length > 0 ? tail.split('\n') : [fallback];

  return (
    <div className="session-logs" role="log" aria-label="Journal de démarrage">
      {lines.map((line, index) => (
        <p
          className="session-logs-line"
          key={`${index}-${line}`}
          data-current={index === lines.length - 1 ? '' : undefined}
        >
          {line}
          {index === lines.length - 1 ? (
            <span className="session-logs-cursor" aria-hidden="true" />
          ) : null}
        </p>
      ))}
    </div>
  );
}

export function StatusOverlay({ session, system, consoleRef }: StatusOverlayProps) {
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

  return (
    <div className="status-overlay" role="status" aria-live="polite">
      <div className="session-progress">
        <header className="session-progress-heading">
          <p className="session-progress-eyebrow">Session en cours</p>
          <h2 className="session-progress-title">{statusText}</h2>
        </header>

        <SessionLogs consoleRef={consoleRef} fallback={statusText} />
      </div>
    </div>
  );
}
