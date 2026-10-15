import type { CSSProperties } from 'react';
import type { OSDefinition } from '@lumiboot/contracts';
import {
  architectureLabels,
  availabilityLabels,
  familyLabels,
  getPrimaryLaunchProfile,
  launchProfileShortLabel,
} from '../../lib/labels';

export interface SystemCardProps {
  system: OSDefinition;
  onOpen: (system: OSDefinition) => void;
}

function accentStyle(system: OSDefinition): CSSProperties {
  return {
    '--accent': system.accent,
    '--accent-rgb': system.accentRgb,
  } as CSSProperties;
}

export function SystemCard({ system, onOpen }: SystemCardProps) {
  const launchProfile = getPrimaryLaunchProfile(system);

  return (
    <article
      className="os-card"
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
