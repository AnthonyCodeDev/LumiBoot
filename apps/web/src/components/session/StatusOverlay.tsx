import { useEffect, useState, type RefObject } from 'react';
import type { OSDefinition } from '@lumiboot/contracts';
import type { SessionSnapshot } from '@lumiboot/vm-core';
import { getPrimaryLaunchProfile } from '../../lib/labels';
import { statusMessageForSession, statusTextForSession } from './statusOverlay.helpers';

export interface StatusOverlayProps {
  session: SessionSnapshot;
  system: OSDefinition;
  /** `.session-console`, which holds the `textarea.v86-serial`. */
  consoleRef: RefObject<HTMLDivElement>;
}

const SERIAL_POLL_MS = 400;
const LOG_LINE_COUNT = 3;
/** Phases where the guest really starts booting: the loading veil must be gone. */
const BOOT_STARTED_PHASES = new Set(['disk-boot', 'guest-ready', 'boot-timeout']);

/** `true` once the session reports that the guest OS itself is booting. */
function bootHasStarted(state: SessionSnapshot['state'], phase?: string): boolean {
  if (state === 'running') return true;
  return phase !== undefined && BOOT_STARTED_PHASES.has(phase);
}

/** Non-empty serial lines; v86 writes into `.value`, even when hidden. */
function readSerialLines(container: HTMLElement | null): string[] {
  const serial = container?.querySelector<HTMLTextAreaElement>('textarea.v86-serial');
  const raw = serial?.value ?? '';
  return raw
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

/** Last non-empty serial lines. */
function readSerialTail(container: HTMLElement | null): string[] {
  return readSerialLines(container).slice(-LOG_LINE_COUNT);
}

/** `true` as soon as the serial buffer holds at least one non-empty line. */
function hasSerialOutput(container: HTMLElement | null): boolean {
  return readSerialLines(container).length > 0;
}

/**
 * Loading veil until the guest actually starts, never on a timer: `true` while
 * there is no serial output, no boot phase and no running state. Once cleared,
 * it never comes back, even if the serial buffer is emptied afterwards.
 */
function useBootVeilVisible(
  consoleRef: RefObject<HTMLDivElement>,
  session: SessionSnapshot,
): boolean {
  const { state, phase } = session;
  const [veilVisible, setVeilVisible] = useState(
    () => !bootHasStarted(state, phase) && !hasSerialOutput(consoleRef.current),
  );

  useEffect(() => {
    if (!veilVisible) return undefined;

    const check = () => {
      if (bootHasStarted(state, phase) || hasSerialOutput(consoleRef.current)) {
        setVeilVisible((prev) => (prev ? false : prev));
      }
    };

    check();
    const timer = window.setInterval(check, SERIAL_POLL_MS);
    return () => window.clearInterval(timer);
  }, [consoleRef, veilVisible, state, phase]);

  return veilVisible;
}

interface SessionLogsProps {
  consoleRef: RefObject<HTMLDivElement>;
  fallback: string;
}

/** Last 3 terminal lines, polled. Always at least the state fallback line. */
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
  // Before every early return so the hook order never changes.
  const veilVisible = useBootVeilVisible(consoleRef, session);

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

  if (!veilVisible) return null;

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
