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
  architectureLabels,
  architectureSummary,
  bootDeviceLabels,
  engineLabels,
  familyLabels,
  getPrimaryLaunchProfile,
  hardwareNetworkLabels,
  systemVersionLabel,
} from '../lib/labels';
import { NotFoundPage } from './NotFoundPage';

/** Human-readable size. */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} bytes`;
}

export function SystemPage() {
  const { slug } = useParams<{ slug: string }>();
  const system = slug ? getSystemBySlug(slug) : null;
  const createSession = useSessionsStore((state) => state.create);
  const navigate = useNavigate();
  // Variant to launch; the page content stays the base one.
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const mediaRecords = useUserMediaStore((state) => state.records);
  const mediaLoading = useUserMediaStore((state) => state.loading);
  const mediaImporting = useUserMediaStore((state) => state.importing);
  const mediaError = useUserMediaStore((state) => state.error);
  const loadMedia = useUserMediaStore((state) => state.load);
  const importMedia = useUserMediaStore((state) => state.importFor);
  const removeMedia = useUserMediaStore((state) => state.remove);
  // Import form fields.
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [mediaManifest, setMediaManifest] = useState<File | null>(null);
  const [licenseAcknowledged, setLicenseAcknowledged] = useState(false);

  // Runtime availability of the variant to launch.
  type RuntimeState =
    { status: 'checking' } | { status: 'available' } | { status: 'unavailable'; reason: string };
  const [runtime, setRuntime] = useState<RuntimeState | null>(null);

  // Sync the selection when the resolved system changes: parent selects its best
  // variant, a direct link to a child selects that child.
  useEffect(() => {
    if (!system) {
      setSelectedId(null);
      return;
    }
    const parent = getVariantParent(system);
    setSelectedId(system.id === parent.id ? getDefaultVariant(parent).id : system.id);
  }, [system]);

  // Reload persisted media once on mount.
  useEffect(() => {
    void loadMedia();
  }, [loadMedia]);

  // Displayed content is always the base variant, whatever is picked.
  const base = system ? getVariantParent(system) : null;
  const variants = base ? getVariantGroup(base) : [];
  // Falls back to the default variant on the first render, before the effect runs.
  const selected = base
    ? (variants.find((variant) => variant.id === selectedId) ?? getDefaultVariant(base))
    : null;

  const mediaRecord = selected ? mediaRecords[selected.id] : undefined;
  const userMediaReady = mediaRecord !== undefined;
  const isUserImport = selected?.mediaStrategy === 'user-import';

  // Declared readiness: catalogue, engine, architecture, memory and imported media.
  const declaredReadiness = selected
    ? getLaunchReadiness(selected, { userMediaReady })
    : { canLaunch: false };

  // Re-check runtime availability when the variant changes.
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
                reason: result.reason ?? 'The system media is unavailable.',
              },
        );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setRuntime({
          status: 'unavailable',
          reason:
            error instanceof Error && error.message ? error.message : 'The media check failed.',
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
  // Spec table reflects the variant to launch, not the displayed parent.
  const profile = getPrimaryLaunchProfile(selected);
  const memoryMiB = profile.configuration?.memoryMiB ?? selected.minMemoryMiB;
  const bootDevice = profile.configuration?.bootDevice;
  const network = profile.hardwareProfile?.network;

  // Launch requires both the declared readiness and a runtime availability check.
  const readiness: LaunchReadiness = !declaredReadiness.canLaunch
    ? declaredReadiness
    : runtime?.status === 'available'
      ? { canLaunch: true }
      : runtime?.status === 'unavailable'
        ? { canLaunch: false, reason: runtime.reason }
        : { canLaunch: false, reason: 'Checking media availability…' };

  async function handleImport(): Promise<void> {
    if (!selected || mediaFile === null) return;
    try {
      await importMedia(selected, mediaFile, licenseAcknowledged, mediaManifest ?? undefined);
      setMediaFile(null);
      setMediaManifest(null);
      setLicenseAcknowledged(false);
    } catch {
      // The store already exposes the error through `mediaError`.
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
        <Link to="/">← Back to the library</Link>
      </p>
      <div className="system-detail-hero" style={style}>
        <img src={base.iconUrl} alt="" />
        <div>
          <span className="drawer-family">
            {familyLabels[base.family]} <span>·</span> {architectureSummary(variants)}
          </span>
          <h1>
            {base.displayName} <span>{systemVersionLabel(base, variants)}</span>
          </h1>
          <p className="drawer-description">{base.description}</p>
          <div className="spec-box">
            <div>
              <span>Engine</span>
              <strong>{engineLabels[profile.engineId]}</strong>
            </div>
            <div>
              <span>Architecture</span>
              <strong>{architectureLabels[selected.architecture]}</strong>
            </div>
            {memoryMiB !== undefined ? (
              <div>
                <span>Memory</span>
                <strong>{memoryMiB} MiB</strong>
              </div>
            ) : null}
            {bootDevice !== undefined ? (
              <div>
                <span>Boot</span>
                <strong>{bootDeviceLabels[bootDevice] ?? bootDevice}</strong>
              </div>
            ) : null}
            {network !== undefined ? (
              <div>
                <span>Network</span>
                <strong>{hardwareNetworkLabels[network]}</strong>
              </div>
            ) : null}
            <div>
              <span>Status</span>
              <strong className={selected.availability === 'ready' ? '' : 'planned-label'}>
                {availabilityLabels[selected.availability]}
              </strong>
            </div>
          </div>
          {isUserImport ? (
            <section className="media-import" aria-labelledby="media-import-title">
              <p className="media-import-eyebrow">Media</p>
              <h3 id="media-import-title">Required media (provided by you)</h3>
              <p className="drawer-bodytext">
                No image is distributed or downloaded for this system. Import a disk you own
                legally: it stays in your browser and is never uploaded.
              </p>
              {mediaLoading ? (
                <p className="drawer-bodytext media-import-loading">Loading media…</p>
              ) : null}
              {mediaRecord ? (
                <div className="media-file-card" role="status">
                  <span className="media-file-card-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24">
                      <circle cx="12" cy="12" r="9" />
                      <circle cx="12" cy="12" r="2.6" />
                    </svg>
                  </span>
                  <div className="media-file-card-body">
                    <p className="media-file-card-name" title={mediaRecord.fileName}>
                      <span className="visually-hidden">Imported media: </span>
                      {mediaRecord.fileName}
                    </p>
                    <p className="media-file-card-meta">
                      <span>{mediaRecord.format.toUpperCase()}</span>
                      <span aria-hidden="true">·</span>
                      <span>{formatBytes(mediaRecord.size)}</span>
                      <span
                        className="media-integrity"
                        data-integrity={
                          mediaRecord.integrity === 'verified' ? 'verified' : 'unverified'
                        }
                      >
                        {mediaRecord.integrity === 'verified' ? 'Verified' : 'Not verified'}
                      </span>
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    type="button"
                    disabled={mediaImporting}
                    onClick={() => {
                      void removeMedia(mediaRecord.ref);
                    }}
                  >
                    Remove media
                  </Button>
                </div>
              ) : null}
              <div className="media-fields">
                <label className="media-file-field" data-state={mediaFile ? 'selected' : 'empty'}>
                  <input
                    className="visually-hidden"
                    type="file"
                    accept=".iso,.img,.raw"
                    aria-label="Disk image file (.iso, .img, .raw)"
                    onChange={handleFileChange}
                  />
                  <span className="media-file-field-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24">
                      <circle cx="12" cy="12" r="9" />
                      <circle cx="12" cy="12" r="2.6" />
                    </svg>
                  </span>
                  <span className="media-file-field-body">
                    <span className="media-file-field-title">
                      <span className="media-file-field-label">Disk image</span>
                    </span>
                    {mediaFile ? (
                      <>
                        <span className="media-file-field-name" title={mediaFile.name}>
                          {mediaFile.name}
                        </span>
                        <span className="media-file-field-sub">
                          <span>{formatBytes(mediaFile.size)}</span>
                          <span className="media-file-field-badge">Replace</span>
                        </span>
                      </>
                    ) : (
                      <span className="media-file-field-hint">.iso · .img · .raw</span>
                    )}
                  </span>
                </label>
                <label
                  className="media-file-field media-file-field--optional"
                  data-state={mediaManifest ? 'selected' : 'empty'}
                >
                  <input
                    className="visually-hidden"
                    type="file"
                    accept=".json,application/json"
                    aria-label="Integrity manifest (JSON, optional)"
                    onChange={handleManifestChange}
                  />
                  <span className="media-file-field-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24">
                      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                      <path d="M14 3v5h5" />
                      <path d="M9 13h5M9 17h3" />
                    </svg>
                  </span>
                  <span className="media-file-field-body">
                    <span className="media-file-field-title">
                      <span className="media-file-optional">Optional</span>
                      <span className="media-file-field-label">Manifest</span>
                    </span>
                    {mediaManifest ? (
                      <>
                        <span className="media-file-field-name" title={mediaManifest.name}>
                          {mediaManifest.name}
                        </span>
                        <span className="media-file-field-sub">
                          <span>{formatBytes(mediaManifest.size)}</span>
                          <span className="media-file-field-badge">Replace</span>
                        </span>
                      </>
                    ) : (
                      <span className="media-file-field-hint">.json</span>
                    )}
                  </span>
                </label>
              </div>
              <label className="media-license">
                <input
                  type="checkbox"
                  checked={licenseAcknowledged}
                  onChange={(event) => setLicenseAcknowledged(event.target.checked)}
                />
                <span>I confirm that I hold a license and the right to use this media.</span>
              </label>
              <div className="media-import-actions">
                <Button
                  variant="primary"
                  type="button"
                  disabled={mediaFile === null || !licenseAcknowledged || mediaImporting}
                  onClick={() => {
                    void handleImport();
                  }}
                >
                  {mediaImporting ? 'Importing…' : 'Import media'}
                </Button>
                <p className="media-import-hint">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="4" y="10" width="16" height="10" rx="2" />
                    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
                  </svg>
                  Stays in your browser · never uploaded
                </p>
              </div>
              {mediaError ? (
                <p className="media-alert" role="alert">
                  <span className="media-alert-icon" aria-hidden="true">
                    !
                  </span>
                  <span>{mediaError}</span>
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
                  name: `${
                    variant.variantName
                      ? `${base.displayName} ${variant.variantName}`
                      : variant.displayName
                  } · ${architectureLabels[variant.architecture]}`,
                }))}
                value={selected.id}
                onSelect={(variantSlug) => {
                  // Only the variant to launch changes; no navigation.
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
              Start session
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
