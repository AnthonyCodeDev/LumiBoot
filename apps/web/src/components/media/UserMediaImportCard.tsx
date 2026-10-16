import { useEffect, useId, useState } from 'react';
import type { OSDefinition } from '@lumiboot/contracts';
import { formatSessionBytes } from '../session/statusOverlay.helpers';
import { useUserMediaStore } from '../../features/media/user-media.store';

export interface UserMediaImportCardProps {
  system: OSDefinition;
}

/**
 * Import d'un média système fourni légalement par l'utilisateur (ex. disque
 * Windows 7). Carte purement front-end : le fichier reste dans le navigateur,
 * aucune donnée n'est envoyée à un serveur. L'interface reste honnête : tant
 * qu'aucun média n'est importé, le système n'est pas lançable.
 */
export function UserMediaImportCard({ system }: UserMediaImportCardProps) {
  const mediaInputId = useId();
  const manifestInputId = useId();
  const licenseId = useId();

  const records = useUserMediaStore((state) => state.records);
  const importing = useUserMediaStore((state) => state.importing);
  const error = useUserMediaStore((state) => state.error);
  const load = useUserMediaStore((state) => state.load);
  const importFor = useUserMediaStore((state) => state.importFor);
  const remove = useUserMediaStore((state) => state.remove);

  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [manifestFile, setManifestFile] = useState<File | null>(null);
  const [licenseAcknowledged, setLicenseAcknowledged] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  const record = records[system.id];

  const handleImport = async (): Promise<void> => {
    if (!mediaFile || !licenseAcknowledged) return;
    try {
      await importFor(system, mediaFile, licenseAcknowledged, manifestFile ?? undefined);
      setMediaFile(null);
      setManifestFile(null);
      setLicenseAcknowledged(false);
    } catch {
      /* l'erreur est exposée par le store (message utilisateur) */
    }
  };

  return (
    <section className="media-import" aria-labelledby={`${mediaInputId}-title`}>
      <h3 id={`${mediaInputId}-title`}>Média requis (fourni par vous)</h3>
      <p className="drawer-bodytext">
        Aucune image {system.displayName} n’est distribuée par LumiBoot. Importez un disque brut (
        <code>.img</code>/<code>.raw</code>) ou une image ISO que vous détenez et êtes autorisé à
        utiliser. Le fichier reste dans votre navigateur et n’est jamais envoyé à un serveur.
      </p>

      {record ? (
        <div className="media-import-current" role="status">
          <strong>{record.fileName}</strong>
          <span>
            {formatSessionBytes(record.size)} · {record.format.toUpperCase()} ·{' '}
            {record.integrity === 'verified' ? 'intégrité vérifiée' : 'intégrité non vérifiée'}
          </span>
          <button
            type="button"
            className="media-import-remove"
            onClick={() => void remove(system.id)}
          >
            Retirer le média importé
          </button>
        </div>
      ) : null}

      <div className="media-import-fields">
        <label htmlFor={mediaInputId}>Fichier média</label>
        <input
          id={mediaInputId}
          type="file"
          accept=".img,.raw,.iso,application/octet-stream"
          onChange={(event) => setMediaFile(event.target.files?.[0] ?? null)}
        />

        <label htmlFor={manifestInputId}>
          Manifeste optionnel (JSON, pour vérifier le SHA-256)
        </label>
        <input
          id={manifestInputId}
          type="file"
          accept="application/json,.json"
          onChange={(event) => setManifestFile(event.target.files?.[0] ?? null)}
        />

        <div className="media-import-license">
          <input
            id={licenseId}
            type="checkbox"
            checked={licenseAcknowledged}
            onChange={(event) => setLicenseAcknowledged(event.target.checked)}
          />
          <label htmlFor={licenseId}>
            Je détiens une licence valide et le droit d’utiliser ce média.
          </label>
        </div>
      </div>

      <button
        type="button"
        className="media-import-submit"
        disabled={!mediaFile || !licenseAcknowledged || importing}
        onClick={() => void handleImport()}
      >
        {importing ? 'Import en cours…' : 'Importer le média local'}
      </button>

      {error ? (
        <p className="drawer-bodytext media-import-error" role="alert">
          {error}
        </p>
      ) : null}
      <p className="drawer-bodytext media-import-note">
        Remarque : le démarrage Windows via v86 n’est pas encore validé de bout en bout. La session
        n’est jamais annoncée « disponible » sans boot réel prouvé.
      </p>
    </section>
  );
}
