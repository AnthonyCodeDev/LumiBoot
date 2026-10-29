import { useNavigate } from 'react-router-dom';
import type { Availability, OSDefinition } from '@lumiboot/contracts';
import { useCatalogStore } from '../../features/catalog/catalog.store';
import { useVisibleSystems } from '../../features/catalog/catalog.selectors';
import { Button } from '../ui/Button';
import { SystemCard } from './SystemCard';

/** `resource-required` is playable: only the media is supplied by the user. */
const PLAYABLE_AVAILABILITIES: ReadonlySet<Availability> = new Set(['ready', 'resource-required']);

const isPlayable = (system: OSDefinition) => PLAYABLE_AVAILABILITIES.has(system.availability);

export function SystemGrid() {
  const visible = useVisibleSystems();
  const navigate = useNavigate();
  const resetFilters = useCatalogStore((state) => state.resetFilters);

  if (visible.length === 0) {
    return (
      <div className="empty-state" id="empty-state">
        <div className="empty-icon">⌕</div>
        <strong>No systems found</strong>
        <p>Change your search or pick another category.</p>
        <Button variant="outline" type="button" onClick={resetFilters}>
          Reset filters
        </Button>
      </div>
    );
  }

  const playable = visible.filter(isPlayable);
  const pending = visible.filter((system) => !isPlayable(system));

  return (
    <div id="cards" aria-live="polite">
      {playable.length > 0 && (
        <div className="cards">
          {playable.map((system) => (
            <SystemCard
              key={system.id}
              system={system}
              onOpen={(target) => navigate(`/systems/${target.slug}`)}
            />
          ))}
        </div>
      )}
      {playable.length > 0 && pending.length > 0 && <hr className="cards-separator" />}
      {pending.length > 0 && (
        <div className="cards">
          {pending.map((system) => (
            <SystemCard
              key={system.id}
              system={system}
              muted
              onOpen={(target) => navigate(`/systems/${target.slug}`)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
