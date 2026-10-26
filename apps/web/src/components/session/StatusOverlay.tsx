import { useEffect, useState, type RefObject } from 'react';
import type { OSDefinition } from '@lumiboot/contracts';
import type { SessionSnapshot } from '@lumiboot/vm-core';
import { getPrimaryLaunchProfile } from '../../lib/labels';
import { statusMessageForSession, statusTextForSession } from './statusOverlay.helpers';

export interface StatusOverlayProps {
  session: SessionSnapshot;
  system: OSDefinition;
  /** Reference to `.session-console`, which holds the `textarea.v86-serial`. */
  consoleRef: RefObject<HTMLDivElement>;
}

/** Re-read period of the serial terminal (ms). */
const SERIAL_POLL_MS = 400;
/** Number of log lines kept on screen. */
const LOG_LINE_COUNT = 3;

/**
 * Last non-empty lines of the guest serial terminal.
 * v86 writes into `.value` of `<textarea class="v86-serial">`, even when hidden.
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
 * Log panel: the last 3 terminal lines, refreshed by polling to give the
 * impression of continuous scrolling. Always at least one line (fallback
 * derived from the state) so the panel is never empty.
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
    <div className="session-logs" role="log" aria-label="Boot log">
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
          {mediaRequired ? 'RESOURCE REQUIRED' : 'UNAVAILABLE'}
        </span>
        <h2>{mediaRequired ? 'System media missing.' : 'Session unavailable right now.'}</h2>
        <p>{session.error?.message ?? 'The engine for this system is not ready.'}</p>
        {mediaRequired ? (
          <p>
            Go back to the {system.displayName} page to import media you own legally. LumiBoot ships
            no images.
          </p>
        ) : (
          <p>
            {system.displayName} remains at status “{system.availability}”. The screen appears once
            the actual launch profile (<code>{launchProfile.engineId}</code>) can start this system.
          </p>
        )}
        {session.error ? (
          <p>
            Code: <code>{session.error.code}</code>
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
          <p className="session-progress-eyebrow">Session in progress</p>
          <h2 className="session-progress-title">{statusText}</h2>
        </header>

        <SessionLogs consoleRef={consoleRef} fallback={statusText} />
      </div>
    </div>
  );
}
