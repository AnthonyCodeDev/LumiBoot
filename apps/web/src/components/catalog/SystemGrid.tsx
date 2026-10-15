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
        <strong>Aucun système trouvé</strong>
        <p>Modifiez votre recherche ou sélectionnez une autre catégorie.</p>
        <Button variant="outline" type="button" onClick={resetFilters}>
          Réinitialiser les filtres
        </Button>
      </div>
    );
  }

  return (
    <div className="cards" id="cards" aria-live="polite">
      {visible.map((system) => (
        <SystemCard
          key={system.id}
          system={system}
          onOpen={(target) => navigate(`/systems/${target.slug}`)}
        />
      ))}
    </div>
  );
}
