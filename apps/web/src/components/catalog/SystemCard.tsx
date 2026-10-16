import type { CSSProperties } from 'react';
import type { OSDefinition } from '@lumiboot/contracts';
import { availabilityLabels } from '../../lib/labels';

export interface SystemCardProps {
  system: OSDefinition;
  onOpen: (system: OSDefinition) => void;
  muted?: boolean;
}

function accentStyle(system: OSDefinition): CSSProperties {
  return {
    '--accent': system.accent,
    '--accent-rgb': system.accentRgb,
  } as CSSProperties;
}

export function SystemCard({ system, onOpen, muted = false }: SystemCardProps) {
  return (
    <article
      className={muted ? 'os-card is-muted' : 'os-card'}
      style={accentStyle(system)}
      data-id={system.id}
      tabIndex={0}
      aria-label={`Ouvrir la fiche de ${system.displayName}`}
      onClick={() => onOpen(system)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen(system);
        }
      }}
    >
      <div className="card-cover">
        <span className="card-status" data-state={system.availability}>
          {availabilityLabels[system.availability]}
        </span>
        <img className="os-logo" src={system.iconUrl} alt="" loading="lazy" />
      </div>
      <div className="card-info">
        <h3>{system.displayName}</h3>
        <p className="card-version">{system.versionLabel}</p>
      </div>
    </article>
  );
}
