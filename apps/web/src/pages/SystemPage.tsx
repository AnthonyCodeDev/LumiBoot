import { useEffect, useState, type ChangeEvent, type CSSProperties } from 'react';
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
import { useUserMediaStore } from '../features/media/user-media.store';
import {
  checkSystemRuntimeAvailability,
  getLaunchReadiness,
  type LaunchReadiness,
} from '../lib/launch';
import {
  availabilityLabels,
  bootDeviceLabels,
  engineLabels,
  familyLabels,
  getPrimaryLaunchProfile,
  hardwareNetworkLabels,
} from '../lib/labels';
import { NotFoundPage } from './NotFoundPage';

/** Taille lisible ; miroir local du formatage du store (non exporté). */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} Gio`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} Mio`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} Kio`;
  return `${bytes} octets`;
}

export function SystemPage() {
  const { slug } = useParams<{ slug: string }>();
  const system = slug ? getSystemBySlug(slug) : null;
  const createSession = useSessionsStore((state) => state.create);
  const navigate = useNavigate();
  // Id de la variante À LANCER (état purement local : ne pilote ni l'URL ni le
  // contenu affiché, qui reste toujours celui de la mère/base).
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Médias importés (store persisté : IndexedDB navigateur, repli mémoire).
  const mediaRecords = useUserMediaStore((state) => state.records);
  const mediaLoading = useUserMediaStore((state) => state.loading);
  const mediaImporting = useUserMediaStore((state) => state.importing);
  const mediaError = useUserMediaStore((state) => state.error);
  const loadMedia = useUserMediaStore((state) => state.load);
  const importMedia = useUserMediaStore((state) => state.importFor);
  const removeMedia = useUserMediaStore((state) => state.remove);
  // Champs du formulaire d'import.
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [mediaManifest, setMediaManifest] = useState<File | null>(null);
  const [licenseAcknowledged, setLicenseAcknowledged] = useState(false);

  // Disponibilité runtime (manifeste + disque HTTP Range) de la variante à lancer.
  type RuntimeState =
    { status: 'checking' } | { status: 'available' } | { status: 'unavailable'; reason: string };
  const [runtime, setRuntime] = useState<RuntimeState | null>(null);

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

  // Restoration après rafraîchissement : recharge les médias persistés une fois
  // au montage (le store est un singleton ; `load` est stable).
  useEffect(() => {
    void loadMedia();
  }, [loadMedia]);

  // Contenu affiché : TOUJOURS celui de la mère/base (« Debian de base »), quel
  // que soit la variante choisie dans le dropdown.
  const base = system ? getVariantParent(system) : null;
  const variants = base ? getVariantGroup(base) : [];
  // Variante à lancer : la sélection locale, ou la meilleure variante par défaut
  // (couvre le premier rendu, avant l'exécution du `useEffect`).
  const selected = base
    ? (variants.find((variant) => variant.id === selectedId) ?? getDefaultVariant(base))
    : null;

  const mediaRecord = selected ? mediaRecords[selected.id] : undefined;
  const userMediaReady = mediaRecord !== undefined;
  const isUserImport = selected?.mediaStrategy === 'user-import';

  // Readiness déclarée (catalogue, moteur, architecture, mémoire, média importé).
  const declaredReadiness = selected
    ? getLaunchReadiness(selected, { userMediaReady })
    : { canLaunch: false };

  // Vérifie le média réellement servable (manifeste JSON + disque HTTP Range)
  // dès que la variante change et que les conditions déclarées sont réunies.
  useEffect(() => {
    if (!selected || !declaredReadiness.canLaunch) {
      setRuntime(null);
      return;
    }
    let cancelled = false;
    setRuntime({ status: 'checking' });
    checkSystemRuntimeAvailability(selected)
      .then((result) => {
        if (cancelled) return;
        setRuntime(
          result.available
            ? { status: 'available' }
            : {
                status: 'unavailable',
                reason: result.reason ?? 'Le média système est indisponible.',
              },
        );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setRuntime({
          status: 'unavailable',
          reason:
            error instanceof Error && error.message
              ? error.message
              : 'La vérification du média a échoué.',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [selected, declaredReadiness.canLaunch, userMediaReady]);

  if (!system || !base || !selected) return <NotFoundPage />;

  const style = {
    '--accent': base.accent,
    '--accent-rgb': base.accentRgb,
  } as CSSProperties;
  // Profil principal de la variante À LANCER : le tableau de spécifications
  // reflète la sélection (mémoire, réseau…), pas la mère affichée.
  const profile = getPrimaryLaunchProfile(selected);
  const memoryMiB = profile.configuration?.memoryMiB ?? selected.minMemoryMiB;
  const bootDevice = profile.configuration?.bootDevice;
  const network = profile.hardwareProfile?.network;

  // Le bouton n'est actif que si le catalogue autorise le lancement ET que le
  // média est réellement disponible au runtime. Toute indisponibilité produit
  // une raison EXPLICITE (404, repli HTML de SPA, absence de Range, archi…).
  const readiness: LaunchReadiness = !declaredReadiness.canLaunch
    ? declaredReadiness
    : runtime?.status === 'available'
      ? { canLaunch: true }
      : runtime?.status === 'unavailable'
        ? { canLaunch: false, reason: runtime.reason }
        : { canLaunch: false, reason: 'Vérification de la disponibilité du média…' };

  async function handleImport(): Promise<void> {
    if (!selected || mediaFile === null) return;
    try {
      await importMedia(selected, mediaFile, licenseAcknowledged, mediaManifest ?? undefined);
      setMediaFile(null);
      setMediaManifest(null);
      setLicenseAcknowledged(false);
    } catch {
      // L'erreur est déjà exposée par le store (`mediaError`) : pas de doublon.
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>): void {
    setMediaFile(event.target.files?.[0] ?? null);
  }

  function handleManifestChange(event: ChangeEvent<HTMLInputElement>): void {
    setMediaManifest(event.target.files?.[0] ?? null);
  }

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
          {isUserImport ? (
            <section className="media-import" aria-label="Média requis (fourni par vous)">
              <h3>Média requis (fourni par vous)</h3>
              <p className="drawer-bodytext">
                LumiBoot ne distribue ni ne télécharge aucune image de ce système. Importez un média
                disque que vous détenez légalement : il reste dans votre navigateur et n’est jamais
                envoyé à un serveur.
              </p>
              {mediaLoading ? <p className="drawer-bodytext">Chargement des médias…</p> : null}
              {mediaRecord ? (
                <div className="media-import-current" role="status">
                  <p className="drawer-bodytext">
                    Média importé : <strong>{mediaRecord.fileName}</strong> (
                    {mediaRecord.format.toUpperCase()}, {formatBytes(mediaRecord.size)}) —{' '}
                    {mediaRecord.integrity === 'verified'
                      ? 'intégrité vérifiée'
                      : 'intégrité non vérifiée'}
                  </p>
                  <Button
                    variant="ghost"
                    type="button"
                    disabled={mediaImporting}
                    onClick={() => {
                      void removeMedia(mediaRecord.ref);
                    }}
                  >
                    Supprimer le média
                  </Button>
                </div>
              ) : null}
              <div className="media-import-fields">
                <label>
                  <span>Fichier média (.iso, .img, .raw)</span>
                  <input type="file" accept=".iso,.img,.raw" onChange={handleFileChange} />
                </label>
                <label>
                  <span>Manifeste d’intégrité optionnel (JSON)</span>
                  <input
                    type="file"
                    accept=".json,application/json"
                    onChange={handleManifestChange}
                  />
                </label>
                <label className="media-license">
                  <input
                    type="checkbox"
                    checked={licenseAcknowledged}
                    onChange={(event) => setLicenseAcknowledged(event.target.checked)}
                  />
                  <span>J’atteste détenir une licence et le droit d’usage de ce média.</span>
                </label>
              </div>
              <Button
                variant="primary"
                type="button"
                disabled={mediaFile === null || !licenseAcknowledged || mediaImporting}
                onClick={() => {
                  void handleImport();
                }}
              >
                {mediaImporting ? 'Import en cours…' : 'Importer le média'}
              </Button>
              {mediaError ? (
                <p className="drawer-bodytext" role="alert">
                  {mediaError}
                </p>
              ) : null}
            </section>
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
