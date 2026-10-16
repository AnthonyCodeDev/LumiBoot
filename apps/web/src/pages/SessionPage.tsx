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
    // Le composant est monté dès que l'effet s'exécute ; seul le nettoyage le
    // marque démonté. On positionne donc le drapeau AVANT tout retour anticipé :
    // pendant un redémarrage, la session disparaît transitoirement du store,
    // l'effet se relance avec `system === null` puis le composant se re-rend
    // pour la nouvelle session. Ce n'est PAS un démontage, et le redémarrage ne
    // doit pas être abandonné à tort (sinon la page resterait bloquée sur
    // « Session expirée »).
    mountedRef.current = true;
    const element = consoleRef.current;
    if (sessionId && system && element) {
      activeIdRef.current = sessionId;
      // Tout rejet asynchrone du boot est capturé côté UI : jamais de promesse
      // non gérée. Une erreur de démarrage est par ailleurs normalisée en statut
      // de session par le store ; ce `catch` n'écrase une éventuelle nouvelle
      // session que si celle-ci est toujours la session active.
      boot(sessionId, element).catch((error) => {
        if (!mountedRef.current || activeIdRef.current !== sessionId) return;
        setActionError(toUserMessage(error));
      });
    }

    return () => {
      mountedRef.current = false;
      if (!sessionId) return;
      // React StrictMode démonte puis remonte de façon synchrone. On repousse
      // la libération dans une macrotâche : si la même session est réactivée
      // immédiatement (montage double), on l'annule ; sinon (navigation ou
      // démontage réel) on libère la session pour ne laisser aucun orphelin.
      window.setTimeout(() => {
        const superseded = activeIdRef.current === sessionId && mountedRef.current;
        if (superseded) return;
        dispose(sessionId).catch(() => {
          /* la libération best-effort ne doit jamais remonter à l'UI */
        });
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
    const restartingId = session.id;
    setRestarting(true);
    setActionError(null);
    try {
      // Arrêter ET libérer l'ancienne session avant d'en créer une nouvelle.
      await stop(restartingId);
      await dispose(restartingId);
      // Si l'utilisateur a quitté ou changé de session pendant l'arrêt, une
      // navigation tardive écraserait la nouvelle session : on s'abstient.
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
