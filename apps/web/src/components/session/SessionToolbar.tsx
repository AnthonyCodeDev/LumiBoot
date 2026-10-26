import type { OSDefinition } from '@lumiboot/contracts';
import type { SessionSnapshot, VMState } from '@lumiboot/vm-core';
import { Button } from '../ui/Button';
import { engineShortLabels, getPrimaryLaunchProfile } from '../../lib/labels';
import { resolveNetworkProfile } from '../../config/runtime';
import { useSessionsStore } from '../../features/sessions/sessions.store';

/** States during which a stop request makes sense. */
const STOPPABLE: readonly VMState[] = ['preparing', 'downloading', 'booting', 'running'];

export interface SessionToolbarProps {
  session: SessionSnapshot;
  system: OSDefinition;
  onStop: () => void;
  onRestart: () => void;
  transitioning?: boolean;
  isFullscreen?: boolean;
  onToggleFullscreen?: (() => void) | undefined;
  logsOpen?: boolean;
  onToggleLogs?: (() => void) | undefined;
}

export function SessionToolbar({
  session,
  system,
  onStop,
  onRestart,
  transitioning = false,
  isFullscreen = false,
  onToggleFullscreen,
  logsOpen = false,
  onToggleLogs,
}: SessionToolbarProps) {
  const launchProfile = getPrimaryLaunchProfile(system);
  const canStop = STOPPABLE.includes(session.state);
  // Network mode **actually used when the session booted** (recorded by the
  // store on `boot`, e.g. `local-proxy` through automatic selection), not the
  // configured mode. Falls back to the configured mode when the session is not
  // registered yet, then stays silent outside a loaded runtime (unit tests):
  // no crash.
  const effectiveMode = useSessionsStore((s) => s.networkModes[session.id]);
  let networkMode: string | null = null;
  try {
    networkMode = effectiveMode ?? resolveNetworkProfile(system.id).mode;
  } catch {
    networkMode = effectiveMode ?? null;
  }

  return (
    <div className="session-toolbar" data-state={session.state} data-session-id={session.id}>
      <div className="session-toolbar-left">
        <img src={system.iconUrl} alt="" />
        <div className="session-title">
          <h1>{system.displayName}</h1>
          <p>
            {system.versionLabel} · {engineShortLabels[launchProfile.engineId]}
          </p>
        </div>
      </div>
      <div className="session-actions">
        {networkMode ? (
          <span className="session-network-badge" data-testid="session-network-mode">
            Network: {networkMode}
          </span>
        ) : null}
        {onToggleFullscreen ? (
          <Button
            variant="outline"
            type="button"
            onClick={onToggleFullscreen}
            aria-pressed={isFullscreen}
            title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Show the session in fullscreen'}
          >
            {isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          </Button>
        ) : null}
        {onToggleLogs ? (
          <Button
            variant="outline"
            type="button"
            onClick={onToggleLogs}
            aria-pressed={logsOpen}
            title={logsOpen ? 'Hide logs' : 'Show logs'}
          >
            Logs
          </Button>
        ) : null}
        <Button
          variant="outline"
          type="button"
          onClick={onStop}
          disabled={transitioning || !canStop}
        >
          Stop
        </Button>
        <Button variant="primary" type="button" onClick={onRestart} disabled={transitioning}>
          Restart
        </Button>
      </div>
    </div>
  );
}
