import { useCallback, useEffect, useState } from 'react';
import type { OSDefinition } from '@lumiboot/contracts';
import type { SessionSnapshot } from '@lumiboot/vm-core';
import { SessionToolbar } from './SessionToolbar';
import { StatusOverlay } from './StatusOverlay';

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

  // Cible du plein écran : uniquement l'écran résultat (le VGA `.v86-screen`
  // injecté par le provider dans `.session-console`), pas la page entière.
  const getScreenElement = useCallback(
    (): HTMLElement | null => consoleRef.current?.querySelector<HTMLElement>('.v86-screen') ?? null,
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
          /* sortie plein écran refusée : on reste en place */
        });
      } else if (typeof doc.webkitExitFullscreen === 'function') {
        void Promise.resolve(doc.webkitExitFullscreen()).catch(() => {
          /* repli webkit indisponible */
        });
      }
      return;
    }
    const el = getScreenElement() as FullscreenElement | null;
    if (!el) return;
    if (typeof el.requestFullscreen === 'function') {
      void el.requestFullscreen().catch(() => {
        /* demande refusée ou non supportée : on reste en place */
      });
    } else if (typeof el.webkitRequestFullscreen === 'function') {
      void Promise.resolve(el.webkitRequestFullscreen()).catch(() => {
        /* repli webkit indisponible */
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
      {/*
        Le conteneur de console reste monté pendant toutes les phases :
        démonter/remonter la VM sur un simple changement d'état casserait la
        session. L'overlay informe sans bloquer le terminal une fois `running`.
      */}
      <div className="session-viewport">
        <div className={`session-console${logsOpen ? '' : ' logs-hidden'}`} ref={consoleRef} />
        {!running ? <StatusOverlay session={session} system={system} /> : null}
      </div>
    </div>
  );
}
