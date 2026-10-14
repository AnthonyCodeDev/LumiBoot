import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <main className="not-found">
      <h1>Page introuvable</h1>
      <p>
        Cette adresse ne correspond à aucune page de LumiBoot. Revenez à la bibliothèque pour
        explorer les systèmes disponibles.
      </p>
      <Link className="btn btn-primary" to="/">
        Retour à la bibliothèque
      </Link>
    </main>
  );
}
