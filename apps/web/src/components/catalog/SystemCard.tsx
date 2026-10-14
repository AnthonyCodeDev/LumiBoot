import type { CSSProperties } from 'react';
import type { OSDefinition } from '@lumiboot/contracts';
import {
  architectureLabels,
  familyLabels,
  getPrimaryLaunchProfile,
  launchProfileShortLabel,
} from '../../lib/labels';

export interface SystemCardProps {
  system: OSDefinition;
  favorite: boolean;
  onOpen: (system: OSDefinition) => void;
  onToggleFavorite: (id: string) => void;
}

function accentStyle(system: OSDefinition): CSSProperties {
  return {
    '--accent': system.accent,
    '--accent-rgb': system.accentRgb,
  } as CSSProperties;
}

export function SystemCard({ system, favorite, onOpen, onToggleFavorite }: SystemCardProps) {
  const launchProfile = getPrimaryLaunchProfile(system);

  return (
    <article
      className="os-card"
      style={accentStyle(system)}
      data-id={system.id}
      onClick={() => onOpen(system)}
    >
      <div className="card-cover">
        <img className="os-logo" src={system.iconUrl} alt="" loading="lazy" />
        <button
          className={`favorite-button${favorite ? ' is-favorite' : ''}`}
          type="button"
          data-action="favorite"
          aria-label={favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}
          aria-pressed={favorite}
          onClick={(event) => {
            event.stopPropagation();
            onToggleFavorite(system.id);
          }}
        >
          {favorite ? '★' : '☆'}
        </button>
      </div>
      <div className="card-info">
        <h3>{system.displayName}</h3>
        <p className="card-version">{system.versionLabel}</p>
        <div className="card-meta">
          <span>
            {familyLabels[system.family]} · {architectureLabels[system.architecture]}
          </span>
          <span className="card-mode">{launchProfileShortLabel(launchProfile)}</span>
        </div>
      </div>
    </article>
  );
}
