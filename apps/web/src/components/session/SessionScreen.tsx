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

export function SessionScreen({
  session,
  system,
  onStop,
  onRestart,
  transitioning = false,
  consoleRef,
}: SessionScreenProps) {
  const running = session.state === 'running';

  return (
    <div className="session-screen">
      <SessionToolbar
        session={session}
        system={system}
        transitioning={transitioning}
        onStop={onStop}
        onRestart={onRestart}
      />
      {/*
        Le conteneur de console reste monté pendant toutes les phases :
        démonter/remonter la VM sur un simple changement d'état casserait la
        session. L'overlay informe sans bloquer le terminal une fois `running`.
      */}
      <div className="session-viewport">
        <div className="session-console" ref={consoleRef} />
        {!running ? <StatusOverlay session={session} system={system} /> : null}
      </div>
      <p className="session-note">
        Console interactive du système invité. L&apos;écran n&apos;apparaît qu&apos;après un démarrage
        réel du moteur puis du noyau.
      </p>
    </div>
  );
}
