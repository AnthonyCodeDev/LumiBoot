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

/** Human-readable size; local mirror of the store formatting (not exported). */
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
  // ID of the variant TO LAUNCH (purely local state: it drives neither the URL nor
  // the displayed content, which always stays the base/parent one).
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Imported media (persisted store: browser IndexedDB, in-memory fallback).
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

  // Runtime availability (manifest + HTTP Range disk) of the variant to launch.
  type RuntimeState =
    { status: 'checking' } | { status: 'available' } | { status: 'unavailable'; reason: string };
  const [runtime, setRuntime] = useState<RuntimeState | null>(null);

  // Sync the selection when the resolved system changes:
  // - parent (or standalone system) → best variant by default;
  // - direct link to a child → that child.
  // `system` comes from the catalogue: its reference is stable as long as the
  // slug does not change (no render loop).
  useEffect(() => {
    if (!system) {
      setSelectedId(null);
      return;
    }
    const parent = getVariantParent(system);
    setSelectedId(system.id === parent.id ? getDefaultVariant(parent).id : system.id);
  }, [system]);

  // Restore after refresh: reload persisted media once on mount (the store is a
  // singleton and `load` is stable).
  useEffect(() => {
    void loadMedia();
  }, [loadMedia]);

  // Displayed content: ALWAYS the parent/base one ("base Debian"), whatever
  // variant is picked in the dropdown.
  const base = system ? getVariantParent(system) : null;
  const variants = base ? getVariantGroup(base) : [];
  // Variant to launch: the local selection, or the best variant by default
  // (covers the first render, before the `useEffect` runs).
  const selected = base
    ? (variants.find((variant) => variant.id === selectedId) ?? getDefaultVariant(base))
    : null;

  const mediaRecord = selected ? mediaRecords[selected.id] : undefined;
  const userMediaReady = mediaRecord !== undefined;
  const isUserImport = selected?.mediaStrategy === 'user-import';

  // Declared readiness (catalogue, engine, architecture, memory, imported media).
  const declaredReadiness = selected
    ? getLaunchReadiness(selected, { userMediaReady })
    : { canLaunch: false };

  // Checks that the media is really servable (JSON manifest + HTTP Range disk)
  // whenever the variant changes and the declared conditions are met.
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
  // Main profile of the variant TO LAUNCH: the spec table reflects the selection
  // (memory, network…), not the displayed parent.
  const profile = getPrimaryLaunchProfile(selected);
  const memoryMiB = profile.configuration?.memoryMiB ?? selected.minMemoryMiB;
  const bootDevice = profile.configuration?.bootDevice;
  const network = profile.hardwareProfile?.network;

  // The button is only enabled when the catalogue allows the launch AND the media
  // is really available at runtime. Any unavailability yields an EXPLICIT reason
  // (404, SPA HTML fallback, missing Range, architecture…).
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
      // The error is already exposed by the store (`mediaError`): no duplicate.
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
            {familyLabels[base.family]} <span>·</span> {base.architecture.toUpperCase()}
          </span>
          <h1>
            {base.displayName} <span>{base.versionLabel}</span>
          </h1>
          <p className="drawer-description">{base.description}</p>
          <div className="spec-box">
            <div>
              <span>Engine</span>
              <strong>{engineLabels[profile.engineId]}</strong>
            </div>
            <div>
              <span>Architecture</span>
              <strong>{selected.architecture}</strong>
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
          {base.licenseNotes ? (
            <>
              <h3>Licenses</h3>
              <p className="drawer-bodytext">{base.licenseNotes}</p>
            </>
          ) : null}
          {isUserImport ? (
            <section className="media-import" aria-label="Required media (provided by you)">
              <h3>Required media (provided by you)</h3>
              <p className="drawer-bodytext">
                LumiBoot neither distributes nor downloads any image for this system. Import a disk
                media you own legally: it stays in your browser and is never uploaded to a server.
              </p>
              {mediaLoading ? <p className="drawer-bodytext">Loading media…</p> : null}
              {mediaRecord ? (
                <div className="media-import-current" role="status">
                  <p className="drawer-bodytext">
                    Imported media: <strong>{mediaRecord.fileName}</strong> (
                    {mediaRecord.format.toUpperCase()}, {formatBytes(mediaRecord.size)}) —{' '}
                    {mediaRecord.integrity === 'verified'
                      ? 'integrity verified'
                      : 'integrity not verified'}
                  </p>
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
              <div className="media-import-fields">
                <label>
                  <span>Media file (.iso, .img, .raw)</span>
                  <input type="file" accept=".iso,.img,.raw" onChange={handleFileChange} />
                </label>
                <label>
                  <span>Optional integrity manifest (JSON)</span>
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
                  <span>I confirm that I hold a license and the right to use this media.</span>
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
                {mediaImporting ? 'Importing…' : 'Import media'}
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
                  // Label "base name + specificity" (e.g. "Debian XFCE").
                  name: variant.variantName
                    ? `${base.displayName} ${variant.variantName}`
                    : variant.displayName,
                }))}
                value={selected.id}
                onSelect={(variantSlug) => {
                  // The dropdown only picks the variant to launch: no navigation,
                  // the page content stays the base one.
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
