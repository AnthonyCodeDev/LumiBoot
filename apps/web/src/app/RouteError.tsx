import { isRouteErrorResponse, Link, useRouteError } from 'react-router-dom';

function getTechnicalMessage(error: unknown): string {
  if (isRouteErrorResponse(error)) {
    return `${error.status} ${error.statusText}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'An unexpected error occurred.';
}

export function RouteError() {
  const error = useRouteError();
  const technicalMessage = getTechnicalMessage(error);

  return (
    <main className="route-error" role="alert">
      <span className="route-error-badge">Error</span>
      <h1>Something went wrong</h1>
      <p>
        This page could not be displayed. It is most likely a temporary problem. You can reload the
        page or go back to the library to keep browsing.
      </p>
      {import.meta.env.DEV ? (
        <details>
          <summary>Technical details</summary>
          <pre className="route-error-details">{technicalMessage}</pre>
        </details>
      ) : null}
      <div className="route-error-actions">
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
          Reload the page
        </button>
        <Link className="btn" to="/">
          Back to the library
        </Link>
      </div>
    </main>
  );
}
