import { useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useCatalogStore } from '../../features/catalog/catalog.store';
import { useSelectedSystem } from '../../features/catalog/catalog.selectors';
import { useSessionsStore } from '../../features/sessions/sessions.store';
import { Button } from '../ui/Button';
import { getLaunchReadiness } from '../../lib/launch';
import {
  availabilityLabels,
  familyLabels,
  getPrimaryLaunchProfile,
  launchProfileLabel,
} from '../../lib/labels';
import type { CSSProperties } from 'react';
import type { OSDefinition } from '@lumiboot/contracts';

function accentStyle(system: OSDefinition): CSSProperties {
  return {
    '--accent': system.accent,
    '--accent-rgb': system.accentRgb,
  } as CSSProperties;
}

export function SystemDetailDrawer() {
  const system = useSelectedSystem();
  const closeDetails = useCatalogStore((state) => state.closeDetails);
  const createSession = useSessionsStore((state) => state.create);
  const navigate = useNavigate();

  const drawerRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const open = system !== null;

  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement as HTMLElement | null;
    document.body.classList.add('drawer-open');
    closeRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeDetails();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = drawerRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled])',
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.classList.remove('drawer-open');
      const previous = previousFocus.current;
      if (previous && previous.isConnected) previous.focus();
    };
  }, [open, closeDetails]);

  const launchProfile = system ? getPrimaryLaunchProfile(system) : null;
  const readiness = system ? getLaunchReadiness(system) : null;

  const launch = () => {
    if (!system || (readiness && !readiness.canLaunch)) return;
    const id = createSession(system.id);
    closeDetails();
    navigate(`/session/${id}`);
  };

  return (
    <>
      {open ? <div className="drawer-scrim" onClick={closeDetails} /> : null}
      <aside
        ref={drawerRef}
        className={`detail-drawer${open ? ' open' : ''}`}
        aria-hidden={!open}
        aria-labelledby="drawer-title"
        role="dialog"
        aria-modal="true"
      >
        <div className="drawer-header">
          <span className="drawer-overline">FICHE SYSTÈME</span>
          <button
            ref={closeRef}
            className="icon-button"
            type="button"
            aria-label="Fermer les détails"
            onClick={closeDetails}
          >
            ×
          </button>
        </div>
        {system ? (
          <div>
            <div className="drawer-cover" style={accentStyle(system)}>
              <img src={system.iconUrl} alt="" />
              <span>
                {familyLabels[system.family]} / {system.architecture.toUpperCase()}
              </span>
            </div>
            <div className="drawer-overview">
              <span className="drawer-family">
                {familyLabels[system.family]} <span>·</span> ENVIRONNEMENT VIRTUEL
              </span>
              <h2 id="drawer-title">{system.displayName}</h2>
              <p className="drawer-version">{system.versionLabel}</p>
              <p className="drawer-description">{system.description}</p>
              <div className="spec-box">
                <div>
                  <span>Architecture</span>
                  <strong>{system.architecture}</strong>
                </div>
                <div>
                  <span>Mode d&apos;exécution</span>
                  <strong>Dans le navigateur</strong>
                </div>
                <div>
                  <span>Moteur envisagé</span>
                  <strong>
                    {launchProfile ? launchProfileLabel(launchProfile) : 'Navigateur local'}
                  </strong>
                </div>
                <div>
                  <span>État actuel</span>
                  <strong className={system.availability === 'ready' ? '' : 'planned-label'}>
                    {availabilityLabels[system.availability]}
                  </strong>
                </div>
              </div>
              <h3>Pré-requis</h3>
              <p className="drawer-bodytext">{system.requirements.join(' · ')}</p>
              <h3>État de l&apos;intégration</h3>
              <p className="drawer-bodytext">{system.integrationNote}</p>
              <div className="drawer-actions">
                <Button
                  variant="primary"
                  type="button"
                  onClick={launch}
                  disabled={readiness ? !readiness.canLaunch : false}
                >
                  Lancer une session
                </Button>
                {readiness && !readiness.canLaunch && readiness.reason ? (
                  <p className="drawer-bodytext" role="status">
                    {readiness.reason}
                  </p>
                ) : null}
                <Link
                  className="btn btn-outline drawer-fav"
                  to={`/systems/${system.slug}`}
                  onClick={closeDetails}
                >
                  Ouvrir la fiche complète ↗
                </Link>
              </div>
            </div>
          </div>
        ) : null}
      </aside>
    </>
  );
}
