import { useEffect, useRef } from 'react';
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

  const system = session ? getSystemById(session.systemId) : null;
  const sessionId = session?.id;

  useEffect(() => {
    if (!sessionId || !system) return;
    const element = consoleRef.current;
    if (!element) return;
    void boot(sessionId, element);
    return () => {
      void dispose(sessionId);
    };
  }, [sessionId, system, boot, dispose]);

  if (!session || !system) {
    return (
      <main className="not-found">
        <h1>Session introuvable</h1>
        <p>
          Aucune session ne correspond à cet identifiant. Créez une session depuis la bibliothèque
          pour continuer.
        </p>
        <Button variant="primary" type="button" onClick={() => navigate('/')}>
          Retour à la bibliothèque
        </Button>
      </main>
    );
  }

  return (
    <SessionScreen
      session={session}
      system={system}
      consoleRef={consoleRef}
      onStop={() => {
        void stop(session.id);
      }}
      onRestart={() => {
        const nextId = createSession(system.id);
        navigate(`/session/${nextId}`, { replace: true });
      }}
    />
  );
}
