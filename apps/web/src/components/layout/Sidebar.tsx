import { Link, useLocation } from 'react-router-dom';
import { useCatalogStore } from '../../features/catalog/catalog.store';
import { useToastStore } from '../../features/ui/toast.store';

export function Sidebar() {
  const location = useLocation();
  const setFamily = useCatalogStore((state) => state.setFamily);
  const showToast = useToastStore((state) => state.show);
  const homeActive = location.pathname === '/';

  const showFavorites = () => {
    setFamily('favorites');
    document.getElementById('catalogue')?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <aside className="sidebar" aria-label="Navigation principale">
      <Link to="/" className="brand" aria-label="LumiBoot, accueil">
        <span className="brand-mark">L</span>
      </Link>
      <nav className="sidebar-nav" aria-label="Sections">
        <Link
          className={`side-link${homeActive ? ' active' : ''}`}
          to="/"
          title="Accueil"
          aria-label="Accueil"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z" />
          </svg>
        </Link>
        <a className="side-link" href="#catalogue" title="Bibliothèque" aria-label="Bibliothèque">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
            <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
            <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
            <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
          </svg>
        </a>
        <button
          className="side-link"
          type="button"
          title="Favoris"
          aria-label="Afficher les favoris"
          onClick={showFavorites}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m12 3 2.9 5.8 6.4.9-4.7 4.6 1.1 6.4L12 17.7l-5.7 3 1.1-6.4L2.7 9.7l6.4-.9z" />
          </svg>
        </button>
      </nav>
      <div className="sidebar-bottom">
        <button
          className="side-link"
          type="button"
          title="À propos"
          aria-label="À propos du projet"
          onClick={() =>
            showToast('LumiBoot : interface de lancement d’OS. Les moteurs se branchent par lots.')
          }
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M9.8 9.3a2.5 2.5 0 1 1 4.5 1.5c-.7 1-2.3 1.4-2.3 3.1" />
            <path d="M12 17.4h.01" />
          </svg>
        </button>
      </div>
    </aside>
  );
}
