import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <main className="not-found">
      <h1>Page not found</h1>
      <p>
        This address does not match any LumiBoot page. Go back to the library to browse the
        available systems.
      </p>
      <Link className="btn btn-primary" to="/">
        Back to the library
      </Link>
    </main>
  );
}
