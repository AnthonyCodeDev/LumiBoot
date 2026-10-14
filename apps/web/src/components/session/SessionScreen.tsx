import type { OSDefinition } from '@lumiboot/contracts';
import type { SessionSnapshot } from '@lumiboot/vm-core';
import { SessionToolbar } from './SessionToolbar';
import { StatusOverlay } from './StatusOverlay';

export interface SessionScreenProps {
    session: SessionSnapshot;
    system: OSDefinition;
    onStop: () => void;
    onRestart: () => void;
    consoleRef: React.RefObject<HTMLDivElement>;
}

export function SessionScreen({
    session,
    system,
    onStop,
    onRestart,
    consoleRef,
}: SessionScreenProps) {
    const running = session.state === 'running';

    return (
        <div className="session-screen">
            <SessionToolbar session={session} system={system} onStop={onStop} onRestart={onRestart} />
            <div className="session-viewport">
                <div className="session-console" ref={consoleRef} />
                {!running ? <StatusOverlay session={session} system={system} /> : null}
            </div>
            <p className="session-note">
                Cette page est l&apos;unique point de montage de la console. L&apos;écran invité n&apos;apparaît
                qu&apos;après un démarrage réel du moteur.
            </p>
        </div>
    );
}
