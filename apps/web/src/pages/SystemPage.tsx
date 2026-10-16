import { useEffect, useState, type CSSProperties } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  getDefaultVariant,
  getSystemBySlug,
  getVariantGroup,
  getVariantParent,
} from '@lumiboot/catalog';
import { Button } from '../components/ui/Button';
import { VariantDropdown } from '../components/catalog/VariantDropdown';
import { NetworkProxyCard } from '../components/network/NetworkProxyCard';
import { useSessionsStore } from '../features/sessions/sessions.store';
import { getLaunchReadiness } from '../lib/launch';
import {
  availabilityLabels,
  bootDeviceLabels,
  engineLabels,
  familyLabels,
  getPrimaryLaunchProfile,
  hardwareNetworkLabels,
} from '../lib/labels';
import { NotFoundPage } from './NotFoundPage';

export function SystemPage() {
  const { slug } = useParams<{ slug: string }>();
  const system = slug ? getSystemBySlug(slug) : null;
  const createSession = useSessionsStore((state) => state.create);
  const navigate = useNavigate();
  // Id de la variante À LANCER (état purement local : ne pilote ni l'URL ni le
  // contenu affiché, qui reste toujours celui de la mère/base).
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Synchronise la sélection quand le système résolu change :
  // - mère (ou système autonome) → meilleure variante par défaut ;
  // - lien direct sur un enfant → cet enfant.
  // `system` provient du catalogue : sa référence est stable tant que le slug
  // ne change pas (aucune boucle de rendu).
  useEffect(() => {
    if (!system) {
      setSelectedId(null);
      return;
    }
    const parent = getVariantParent(system);
    setSelectedId(system.id === parent.id ? getDefaultVariant(parent).id : system.id);
  }, [system]);

  if (!system) return <NotFoundPage />;

  // Contenu affiché : TOUJOURS celui de la mère/base (« Debian de base »), quel
  // que soit la variante choisie dans le dropdown.
  const base = getVariantParent(system);
  const variants = getVariantGroup(base);
  // Variante à lancer : la sélection locale, ou la meilleure variante par défaut
  // (couvre le premier rendu, avant l'exécution du `useEffect`).
  const selected = variants.find((variant) => variant.id === selectedId) ?? getDefaultVariant(base);
  const style = {
    '--accent': base.accent,
    '--accent-rgb': base.accentRgb,
  } as CSSProperties;
  // Profil principal de la variante À LANCER : le tableau de spécifications
  // reflète la sélection (mémoire, réseau…), pas la mère affichée.
  const profile = getPrimaryLaunchProfile(selected);
  const readiness = getLaunchReadiness(selected);
  const memoryMiB = profile.configuration?.memoryMiB ?? selected.minMemoryMiB;
  const bootDevice = profile.configuration?.bootDevice;
  const network = profile.hardwareProfile?.network;

  return (
    <main className="system-detail">
      <p>
        <Link to="/">← Retour à la bibliothèque</Link>
      </p>
      <div className="system-detail-hero" style={style}>
        <img src={base.iconUrl} alt="" />
        <div>
          <span className="drawer-family">
            {familyLabels[base.family]} <span>·</span> {base.architecture.toUpperCase()}
          </span>
          <h1>
            {base.displayName} <span>{base.versionLabel}</span>
          </h1>
          <p className="drawer-description">{base.description}</p>
          <div className="spec-box">
            <div>
              <span>Moteur</span>
              <strong>{engineLabels[profile.engineId]}</strong>
            </div>
            <div>
              <span>Architecture</span>
              <strong>{selected.architecture}</strong>
            </div>
            {memoryMiB !== undefined ? (
              <div>
                <span>Mémoire</span>
                <strong>{memoryMiB} Mio</strong>
              </div>
            ) : null}
            {bootDevice !== undefined ? (
              <div>
                <span>Démarrage</span>
                <strong>{bootDeviceLabels[bootDevice] ?? bootDevice}</strong>
              </div>
            ) : null}
            {network !== undefined ? (
              <div>
                <span>Réseau</span>
                <strong>{hardwareNetworkLabels[network]}</strong>
              </div>
            ) : null}
            <div>
              <span>État</span>
              <strong className={selected.availability === 'ready' ? '' : 'planned-label'}>
                {availabilityLabels[selected.availability]}
              </strong>
            </div>
          </div>
          {base.licenseNotes ? (
            <>
              <h3>Licences</h3>
              <p className="drawer-bodytext">{base.licenseNotes}</p>
            </>
          ) : null}
          <div className="system-detail-actions">
            {variants.length > 1 ? (
              <VariantDropdown
                variants={variants.map((variant) => ({
                  id: variant.id,
                  slug: variant.slug,
                  // Libellé « nom de base + spécificité » (ex. « Debian XFCE »).
                  name: variant.variantName
                    ? `${base.displayName} ${variant.variantName}`
                    : variant.displayName,
                }))}
                value={selected.id}
                onSelect={(variantSlug) => {
                  // Le dropdown ne sert qu'à choisir la variante à lancer :
                  // aucune navigation, le contenu de la page reste celui de base.
                  const next = variants.find((variant) => variant.slug === variantSlug);
                  if (next) setSelectedId(next.id);
                }}
              />
            ) : null}
            <Button
              variant="primary"
              type="button"
              disabled={!readiness.canLaunch}
              onClick={() => {
                if (!readiness.canLaunch) return;
                const id = createSession(selected.id);
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
          {readiness.canLaunch ? <NetworkProxyCard /> : null}
        </div>
      </div>
    </main>
  );
}
