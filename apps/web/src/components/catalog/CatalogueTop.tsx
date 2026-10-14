import { useEffect, useRef } from 'react';
import { useCatalogStore } from '../../features/catalog/catalog.store';
import { useVisibleSystems } from '../../features/catalog/catalog.selectors';
import { padCount } from '../../lib/format';

function useSearchShortcut(inputRef: React.RefObject<HTMLInputElement>) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const active = document.activeElement as HTMLElement | null;
      const typing = active ? ['INPUT', 'TEXTAREA'].includes(active.tagName) : false;
      const isSlash = event.key === '/' && !typing;
      const isCommandK = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k';
      if (isSlash || isCommandK) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [inputRef]);
}

export function CatalogueTop() {
  const query = useCatalogStore((state) => state.query);
  const setQuery = useCatalogStore((state) => state.setQuery);
  const visibleCount = useVisibleSystems().length;
  const inputRef = useRef<HTMLInputElement>(null);

  useSearchShortcut(inputRef);

  return (
    <div className="catalogue-top">
      <div className="catalogue-heading-group">
        <h2 id="catalogue-heading">
          Bibliothèque <span className="count">{padCount(visibleCount)}</span>
        </h2>
        <p>Systèmes disponibles dans votre environnement</p>
      </div>
      <div className="catalogue-tools">
        <label className="search" htmlFor="search-input">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6.5" />
            <path d="m15.5 15.5 5 5" />
          </svg>
          <input
            ref={inputRef}
            id="search-input"
            type="search"
            autoComplete="off"
            placeholder="Rechercher un système"
            aria-label="Rechercher un système"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <kbd>/</kbd>
        </label>
        <span className="mode-select" aria-hidden="true">
          Navigateur uniquement
        </span>
      </div>
    </div>
  );
}
