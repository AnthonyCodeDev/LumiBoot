import type { FamilyFilter } from '@lumiboot/catalog';
import type { Architecture, EngineId } from '@lumiboot/contracts';
import { useCatalogStore } from '../../features/catalog/catalog.store';
import { useCatalogFacets } from '../../features/catalog/catalog.selectors';
import { FacetSelect } from './FacetSelect';

const FILTERS: ReadonlyArray<{ value: FamilyFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'linux', label: 'Linux' },
  { value: 'windows', label: 'Windows' },
  { value: 'macos', label: 'macOS' },
];

export function Filters() {
  const family = useCatalogStore((state) => state.family);
  const setFamily = useCatalogStore((state) => state.setFamily);
  const architectures = useCatalogStore((state) => state.architectures);
  const engines = useCatalogStore((state) => state.engines);
  const toggleArchitecture = useCatalogStore((state) => state.toggleArchitecture);
  const toggleEngine = useCatalogStore((state) => state.toggleEngine);
  const facets = useCatalogFacets();

  return (
    <div className="filter-row" aria-label="Filter systems">
      <div className="filter-chips">
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
            </button>
          );
        })}
      </div>
      <div className="filter-facets">
        <FacetSelect
          label="Architecture"
          options={facets.architectures}
          selected={architectures}
          onToggle={(value) => toggleArchitecture(value as Architecture)}
        />
        <FacetSelect
          label="Engine"
          options={facets.engines}
          selected={engines}
          onToggle={(value) => toggleEngine(value as EngineId)}
        />
      </div>
    </div>
  );
}
