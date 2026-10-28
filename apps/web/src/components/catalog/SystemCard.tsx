import type { CSSProperties } from 'react';
import type { OSDefinition } from '@lumiboot/contracts';
import { getVariantGroup } from '@lumiboot/catalog';
import { availabilityLabels, systemVersionLabel } from '../../lib/labels';

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
  const variants = getVariantGroup(system);
  return (
    <article
      className={muted ? 'os-card is-muted' : 'os-card'}
      style={accentStyle(system)}
      data-id={system.id}
      tabIndex={0}
      aria-label={`Open the ${system.displayName} page`}
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
        <p className="card-version">{systemVersionLabel(system, variants)}</p>
      </div>
    </article>
  );
}
