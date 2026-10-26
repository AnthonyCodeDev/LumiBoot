import { useNavigate } from 'react-router-dom';
import { useCatalogStore } from '../../features/catalog/catalog.store';
import { useVisibleSystems } from '../../features/catalog/catalog.selectors';
import { Button } from '../ui/Button';
import { SystemCard } from './SystemCard';

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

  const available = visible.filter((system) => system.availability === 'ready');
  const unavailable = visible.filter((system) => system.availability !== 'ready');

  return (
    <div id="cards" aria-live="polite">
      {available.length > 0 && (
        <div className="cards">
          {available.map((system) => (
            <SystemCard
              key={system.id}
              system={system}
              // The card opens the base system: the variant is picked on its page.
              onOpen={(target) => navigate(`/systems/${target.slug}`)}
            />
          ))}
        </div>
      )}
      {available.length > 0 && unavailable.length > 0 && <hr className="cards-separator" />}
      {unavailable.length > 0 && (
        <div className="cards">
          {unavailable.map((system) => (
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
