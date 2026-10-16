import { isRouteErrorResponse, Link, useRouteError } from 'react-router-dom';

function getTechnicalMessage(error: unknown): string {
  if (isRouteErrorResponse(error)) {
    return `${error.status} ${error.statusText}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Une erreur inattendue est survenue.';
}

export function RouteError() {
  const error = useRouteError();
  const technicalMessage = getTechnicalMessage(error);

  return (
    <main className="route-error" role="alert">
      <span className="route-error-badge">Erreur</span>
      <h1>Oups, quelque chose s&apos;est mal passé</h1>
      <p>
        Cette page n&apos;a pas pu s&apos;afficher. Cela vient probablement d&apos;un problème
        temporaire. Vous pouvez recharger la page ou revenir à la bibliothèque pour continuer.
      </p>
      {import.meta.env.DEV ? (
        <details>
          <summary>Détail technique</summary>
          <pre className="route-error-details">{technicalMessage}</pre>
        </details>
      ) : null}
      <div className="route-error-actions">
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
          Recharger la page
        </button>
        <Link className="btn" to="/">
          Retour à la bibliothèque
        </Link>
      </div>
    </main>
  );
}
