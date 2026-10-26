import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getSystemById } from '@lumiboot/catalog';
import { SessionScreen } from '../components/session/SessionScreen';
import { Button } from '../components/ui/Button';
import { useSession } from '../features/sessions/useSession';
import { useSessionsStore } from '../features/sessions/sessions.store';
import { toUserMessage } from '../lib/errors';

export function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const session = useSession(id);
  const boot = useSessionsStore((state) => state.boot);
  const dispose = useSessionsStore((state) => state.dispose);
  const stop = useSessionsStore((state) => state.stop);
  const createSession = useSessionsStore((state) => state.create);
  const navigate = useNavigate();
  const consoleRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const activeIdRef = useRef<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const system = session ? getSystemById(session.systemId) : null;
  const sessionId = session?.id;

  useEffect(() => {
    // The component is mounted when the effect runs; only cleanup marks it
    // unmounted. The flag is therefore set BEFORE any early return: during a
    // restart, the session temporarily disappears from the store, the effect reruns
    // with `system === null`, then the component re-renders for the new session.
    // This is NOT an unmount, and the restart must not be abandoned wrongly
    // (otherwise the page would stay stuck on "Session expired").
    mountedRef.current = true;
    const element = consoleRef.current;
    if (sessionId && system && element) {
      activeIdRef.current = sessionId;
      // Every asynchronous boot rejection is captured on the UI side: never an
      // unhandled promise. A start error is also normalized into a session status
      // by the store; this `catch` only overwrites a possible new session when it
      // is still the active one.
      boot(sessionId, element).catch((error) => {
        if (!mountedRef.current || activeIdRef.current !== sessionId) return;
        setActionError(toUserMessage(error));
      });
    }

    return () => {
      mountedRef.current = false;
      if (!sessionId) return;
      // React StrictMode unmounts then remounts synchronously. Release is pushed
      // to a macrotask: when the same session is reactivated immediately (double
      // mount) it is cancelled; otherwise (navigation or real unmount) the session
      // is released so no orphan is left behind.
      window.setTimeout(() => {
        const superseded = activeIdRef.current === sessionId && mountedRef.current;
        if (superseded) return;
        dispose(sessionId).catch(() => {
          /* the best-effort release must never surface in the UI */
        });
      }, 0);
    };
  }, [sessionId, system, boot, dispose]);

  if (!session || !system) {
    return (
      <main className="not-found">
        <h1>Session expired</h1>
        <p>
          This session is no longer reachable (page reload or closed session). Create a new session
          to keep going.
        </p>
        <Button variant="primary" type="button" onClick={() => navigate('/')}>
          Back to the library
        </Button>
      </main>
    );
  }

  const restart = async (): Promise<void> => {
    if (restarting) return;
    const restartingId = session.id;
    setRestarting(true);
    setActionError(null);
    try {
      // Stop AND release the previous session before creating a new one.
      await stop(restartingId);
      await dispose(restartingId);
      // If the user left or switched session during the stop, a late navigation
      // would overwrite the new session: abstain.
      if (!mountedRef.current || activeIdRef.current !== restartingId) return;
      const nextId = createSession(system.id);
      navigate(`/session/${nextId}`, { replace: true });
    } catch (error) {
      if (mountedRef.current && activeIdRef.current === restartingId) {
        setActionError(toUserMessage(error));
      }
    } finally {
      setRestarting(false);
    }
  };

  return (
    <>
      <SessionScreen
        session={session}
        system={system}
        consoleRef={consoleRef}
        transitioning={restarting}
        onStop={() => {
          stop(session.id).catch((error) => {
            if (!mountedRef.current || activeIdRef.current !== session.id) return;
            setActionError(toUserMessage(error));
          });
        }}
        onRestart={() => {
          void restart();
        }}
      />
      {actionError ? (
        <p role="alert" className="session-action-error">
          {actionError}
        </p>
      ) : null}
    </>
  );
}
