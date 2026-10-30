import { useCallback, useEffect, useState } from 'react';
import type { OSDefinition } from '@lumiboot/contracts';
import { STANDARD_VM_DISPLAY, type SessionSnapshot } from '@lumiboot/vm-core';
import { DiskDiagnosticsPanel } from './DiskDiagnosticsPanel';
import { SessionLogActivity } from './SessionLogActivity';
import { SessionToolbar } from './SessionToolbar';
import { StatusOverlay } from './StatusOverlay';
import { usePointerLockCapture } from './usePointerLockCapture';

export interface SessionScreenProps {
  session: SessionSnapshot;
  system: OSDefinition;
  onStop: () => void;
  onRestart: () => void;
  transitioning?: boolean;
  consoleRef: React.RefObject<HTMLDivElement>;
}

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => void | Promise<void>;
};

type FullscreenDocument = Document & {
  webkitExitFullscreen?: () => void | Promise<void>;
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
};

export function SessionScreen({
  session,
  system,
  onStop,
  onRestart,
  transitioning = false,
  consoleRef,
}: SessionScreenProps) {
  const running = session.state === 'running';
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenSupported, setFullscreenSupported] = useState(true);
  const [logsOpen, setLogsOpen] = useState(false);
  // Single visible cursor: a click inside the screen captures, Escape releases.
  const {
    captured,
    supported: pointerLockSupported,
    error: pointerLockError,
  } = usePointerLockCapture(consoleRef, running);

  // Fullscreen target resolved through the display contract, never by engine class.
  const getScreenElement = useCallback(
    (): HTMLElement | null =>
      consoleRef.current?.querySelector<HTMLElement>(STANDARD_VM_DISPLAY.screenSelector) ?? null,
    [consoleRef],
  );

  useEffect(() => {
    const doc = document as FullscreenDocument;
    const currentFullscreenElement = (): Element | null =>
      document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
    const syncFullscreenState = () => {
      const fullscreenElement = currentFullscreenElement();
      setIsFullscreen(fullscreenElement != null && fullscreenElement === getScreenElement());
    };
    syncFullscreenState();

    const supported =
      document.fullscreenEnabled ??
      doc.webkitFullscreenEnabled ??
      typeof document.documentElement.requestFullscreen === 'function';
    setFullscreenSupported(Boolean(supported));

    document.addEventListener('fullscreenchange', syncFullscreenState);
    return () => {
      document.removeEventListener('fullscreenchange', syncFullscreenState);
    };
  }, [getScreenElement]);

  const toggleFullscreen = useCallback(() => {
    const doc = document as FullscreenDocument;
    if (document.fullscreenElement ?? doc.webkitFullscreenElement) {
      if (typeof document.exitFullscreen === 'function') {
        void document.exitFullscreen().catch(() => {
          /* fullscreen exit refused: stay as is */
        });
      } else if (typeof doc.webkitExitFullscreen === 'function') {
        void Promise.resolve(doc.webkitExitFullscreen()).catch(() => {
          /* webkit fallback unavailable */
        });
      }
      return;
    }
    const el = getScreenElement() as FullscreenElement | null;
    if (!el) return;
    if (typeof el.requestFullscreen === 'function') {
      void el.requestFullscreen().catch(() => {
        /* request refused or unsupported: stay as is */
      });
    } else if (typeof el.webkitRequestFullscreen === 'function') {
      void Promise.resolve(el.webkitRequestFullscreen()).catch(() => {
        /* webkit fallback unavailable */
      });
    }
  }, [getScreenElement]);

  return (
    <div className="session-screen">
      <SessionToolbar
        session={session}
        system={system}
        transitioning={transitioning}
        onStop={onStop}
        onRestart={onRestart}
        isFullscreen={isFullscreen}
        onToggleFullscreen={fullscreenSupported ? toggleFullscreen : undefined}
        logsOpen={logsOpen}
        onToggleLogs={() => setLogsOpen((open) => !open)}
      />
      {/* The console container stays mounted through every phase: remounting breaks the VM. */}
      <div className="session-viewport">
        <div className={`session-console${logsOpen ? '' : ' logs-hidden'}`} ref={consoleRef} />
        {/* Ring fed by the hidden serial buffer: proves the logs still advance. */}
        <SessionLogActivity consoleRef={consoleRef} />
        {!running ? (
          <StatusOverlay session={session} system={system} consoleRef={consoleRef} />
        ) : null}
        {/* Never clickable and never paints a cursor: the browser hides the host cursor. */}
        {running && pointerLockSupported ? (
          <p
            className="session-pointer-hint"
            data-testid="pointer-lock-hint"
            data-state={captured ? 'captured' : 'released'}
            aria-live="polite"
          >
            {captured ? 'Mouse captured · Esc to release' : 'Click the screen to capture the mouse'}
          </p>
        ) : null}
        {running && pointerLockError ? (
          <p
            className="session-pointer-hint session-pointer-hint--error"
            data-testid="pointer-lock-error"
            role="alert"
          >
            {pointerLockError}
          </p>
        ) : null}
      </div>
      {/* Collapsed by default: a failed boot must be diagnosable without DevTools. */}
      <DiskDiagnosticsPanel />
      {session.state === 'booting' && session.phase === 'boot-timeout' ? (
        <p className="session-boot-note" role="status" data-testid="boot-timeout-note">
          Guest boot not verified yet — still booting, the console stays live.
        </p>
      ) : null}
    </div>
  );
}
