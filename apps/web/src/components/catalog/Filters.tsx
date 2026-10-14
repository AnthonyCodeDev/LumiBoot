import type { FamilyFilter } from '@lumiboot/catalog';
import { useCatalogStore } from '../../features/catalog/catalog.store';
import { useFavoritesStore } from '../../features/favorites/favorites.store';

const FILTERS: ReadonlyArray<{ value: FamilyFilter; label: string }> = [
  { value: 'all', label: 'Tous' },
  { value: 'linux', label: 'Linux' },
  { value: 'windows', label: 'Windows' },
  { value: 'macos', label: 'macOS' },
  { value: 'favorites', label: 'Favoris' },
];

export function Filters() {
  const family = useCatalogStore((state) => state.family);
  const setFamily = useCatalogStore((state) => state.setFamily);
  const favoriteCount = useFavoritesStore((state) => state.ids.size);

  return (
    <div className="filter-row" aria-label="Filtrer les systèmes">
      {FILTERS.map((filter) => {
        const active = filter.value === family;
        return (
          <button
            key={filter.value}
            className={`filter${active ? ' active' : ''}`}
            data-filter={filter.value}
            type="button"
            aria-pressed={active}
            onClick={() => setFamily(filter.value)}
          >
            {filter.label}
            {filter.value === 'favorites' ? (
              <span className="favorite-count">{favoriteCount}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
