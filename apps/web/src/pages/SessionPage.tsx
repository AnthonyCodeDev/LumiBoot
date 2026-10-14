import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getSystemById } from '@lumiboot/catalog';
import { SessionScreen } from '../components/session/SessionScreen';
import { Button } from '../components/ui/Button';
import { useSession } from '../features/sessions/useSession';
import { useSessionsStore } from '../features/sessions/sessions.store';

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

  const system = session ? getSystemById(session.systemId) : null;
  const sessionId = session?.id;

  useEffect(() => {
    if (!sessionId || !system) return;
    const element = consoleRef.current;
    if (!element) return;

    mountedRef.current = true;
    activeIdRef.current = sessionId;
    void boot(sessionId, element);

    return () => {
      mountedRef.current = false;
      // React StrictMode démonte puis remonte de façon synchrone. On repousse
      // la libération dans une macrotâche : si la même session est réactivée
      // immédiatement (montage double), on l'annule ; sinon (navigation ou
      // démontage réel) on libère la session pour ne laisser aucun orphelin.
      window.setTimeout(() => {
        const superseded = activeIdRef.current === sessionId && mountedRef.current;
        if (superseded) return;
        void dispose(sessionId);
      }, 0);
    };
  }, [sessionId, system, boot, dispose]);

  if (!session || !system) {
    return (
      <main className="not-found">
        <h1>Session expirée</h1>
        <p>
          Cette session n'est plus accessible (rechargement de la page ou session fermée). Recréez
          une session pour continuer.
        </p>
        <Button variant="primary" type="button" onClick={() => navigate('/')}>
          Retour à la bibliothèque
        </Button>
      </main>
    );
  }

  const restart = async (): Promise<void> => {
    if (restarting) return;
    setRestarting(true);
    try {
      // Arrêter ET libérer l'ancienne session avant d'en créer une nouvelle.
      await stop(session.id);
      await dispose(session.id);
      const nextId = createSession(system.id);
      navigate(`/session/${nextId}`, { replace: true });
    } finally {
      setRestarting(false);
    }
  };

  return (
    <SessionScreen
      session={session}
      system={system}
      consoleRef={consoleRef}
      transitioning={restarting}
      onStop={() => {
        void stop(session.id);
      }}
      onRestart={() => {
        void restart();
      }}
    />
  );
}
