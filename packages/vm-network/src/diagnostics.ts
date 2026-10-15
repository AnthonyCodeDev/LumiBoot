import type { NetworkTransportKind } from './capabilities';
import type { NetworkErrorCode } from './errors';
import type { NetworkMode } from './modes';

/**
 * État du sous-système réseau d'une session.
 *
 * Sémantique (chaque état décrit une étape distincte, jamais confondue) :
 *
 * - `idle`       : contrôleur créé, `start()` pas encore appelé.
 * - `offline`    : mode hors ligne ; **aucun transport** n'est établi.
 * - `configured` : le profil a été **accepté** (relais syntaxiquement valide),
 *                  mais **le transport n'est pas encore établi**. C'est l'état
 *                  par défaut renvoyé par `start()` pour un mode à transport :
 *                  une URL de relais valide ne prouve rien de plus.
 * - `connecting` : le transport a réellement commencé à se connecter (rapporté
 *                  par le provider, jamais déduit du mode).
 * - `connected`  : le transport est établi, **uniquement** lorsque le provider
 *                  le rapporte via `setStatus('connected')`. Jamais automatique.
 * - `online`     : le transport est établi **et** la connectivité Internet a été
 *                  **vérifiée à l'exécution** (`verified === true`, donc sur
 *                  **sonde `tcp`/`https` réussie**). Jamais déduit du mode, ni
 *                  d'une adresse syntaxiquement correcte, ni du seul `setStatus`.
 * - `error`      : une erreur normalisée a été enregistrée (`lastError`).
 * - `stopped`    : arrêt/destruction explicites.
 */
export type NetworkStatus =
  'idle' | 'configured' | 'connecting' | 'connected' | 'online' | 'offline' | 'error' | 'stopped';

/** Nature d'une **sonde réseau réelle** exécutée à l'exécution. */
export type NetworkProbeKind = 'dns' | 'http' | 'https' | 'tcp';

/**
 * Résultat d'une sonde réseau, **fourni par le provider**. `at` est l'horodatage
 * (ms) de la mesure ; `detail` porte un motif lisible éventuel.
 */
export interface NetworkProbeResult {
  ok: boolean;
  at: number;
  detail?: string;
}

export interface NetworkDiagnostics {
  mode: NetworkMode;
  status: NetworkStatus;
  /** Backend de transport associé au mode (`none`, `fetch` ou `wisp`). */
  transport: NetworkTransportKind;
  /**
   * Vrai **uniquement** sur **preuve réelle** : une sonde `tcp` ou `https`
   * réussie (`ok`). C'est une **fonctionnalité vérifiée** (runtime), alimentée
   * par le provider, et **jamais** déduite du mode ni d'une simple sélection de
   * transport. Les sondes `dns`/`http` ne suffisent pas.
   */
  verified: boolean;
  txBytes: number;
  rxBytes: number;
  lastError?: { code: NetworkErrorCode; message: string };
  /**
   * Dernière sonde connue par nature. Optionnel : absent tant qu'aucune sonde
   * n'a été rapportée.
   */
  probes?: Partial<Record<NetworkProbeKind, NetworkProbeResult>>;
}
