import { useCatalogStore } from '../../features/catalog/catalog.store';
import { useVisibleSystems } from '../../features/catalog/catalog.selectors';
import { useFavoritesStore } from '../../features/favorites/favorites.store';
import { Button } from '../ui/Button';
import { SystemCard } from './SystemCard';

export function SystemGrid() {
  const visible = useVisibleSystems();
  const openDetails = useCatalogStore((state) => state.openDetails);
  const resetFilters = useCatalogStore((state) => state.resetFilters);
  const favorites = useFavoritesStore((state) => state.ids);
  const toggleFavorite = useFavoritesStore((state) => state.toggle);

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
          favorite={favorites.has(system.id)}
          onOpen={(target) => openDetails(target.id)}
          onToggleFavorite={toggleFavorite}
        />
      ))}
    </div>
  );
}
