import { useEffect, useRef } from 'react';
import { useCatalogStore } from '../../features/catalog/catalog.store';

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
  const inputRef = useRef<HTMLInputElement>(null);

  useSearchShortcut(inputRef);

  return (
    <div className="catalogue-top">
      <div className="catalogue-heading-group">
        <h2 id="catalogue-heading">Library</h2>
        <p>Systems available in your environment</p>
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
            placeholder="Search for a system"
            aria-label="Search for a system"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <kbd>/</kbd>
        </label>
      </div>
    </div>
  );
}
