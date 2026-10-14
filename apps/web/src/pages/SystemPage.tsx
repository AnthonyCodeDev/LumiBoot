import type { CSSProperties } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { getSystemBySlug } from '@lumiboot/catalog';
import { Button } from '../components/ui/Button';
import { useSessionsStore } from '../features/sessions/sessions.store';
import { getLaunchReadiness } from '../lib/launch';
import {
  availabilityLabels,
  familyLabels,
  getPrimaryLaunchProfile,
  launchProfileLabel,
  engineLabels,
} from '../lib/labels';
import { NotFoundPage } from './NotFoundPage';

export function SystemPage() {
  const { slug } = useParams<{ slug: string }>();
  const system = slug ? getSystemBySlug(slug) : null;
  const createSession = useSessionsStore((state) => state.create);
  const navigate = useNavigate();

  if (!system) return <NotFoundPage />;

  const style = {
    '--accent': system.accent,
    '--accent-rgb': system.accentRgb,
  } as CSSProperties;
  const launchProfile = getPrimaryLaunchProfile(system);
  const readiness = getLaunchReadiness(system);

  return (
    <main className="system-detail">
      <p>
        <Link to="/">← Retour à la bibliothèque</Link>
      </p>
      <div className="system-detail-hero" style={style}>
        <img src={system.iconUrl} alt="" />
        <div>
          <span className="drawer-family">
            {familyLabels[system.family]} <span>·</span> {system.architecture.toUpperCase()}
          </span>
          <h1>
            {system.displayName} <span>{system.versionLabel}</span>
          </h1>
          <p className="drawer-description">{system.description}</p>
          <div className="spec-box">
            <div>
              <span>Architecture</span>
              <strong>{system.architecture}</strong>
            </div>
            <div>
              <span>Mode d&apos;exécution</span>
              <strong>{launchProfileLabel(launchProfile)}</strong>
            </div>
            <div>
              <span>Moteur envisagé</span>
              <strong>{engineLabels[launchProfile.engineId]}</strong>
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
          {system.licenseNotes ? (
            <>
              <h3>Licences</h3>
              <p className="drawer-bodytext">{system.licenseNotes}</p>
            </>
          ) : null}
          <div className="system-detail-actions">
            <Button
              variant="primary"
              type="button"
              disabled={!readiness.canLaunch}
              onClick={() => {
                if (!readiness.canLaunch) return;
                const id = createSession(system.id);
                navigate(`/session/${id}`);
              }}
            >
              Lancer une session
            </Button>
            {!readiness.canLaunch && readiness.reason ? (
              <p className="drawer-bodytext" role="status">
                {readiness.reason}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </main>
  );
}
