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
 *                  **vérifiée à l'exécution** (`verified === true`). Jamais
 *                  déduit du mode ni d'une adresse syntaxiquement correcte.
 * - `error`      : une erreur normalisée a été enregistrée (`lastError`).
 * - `stopped`    : arrêt/destruction explicites.
 */
export type NetworkStatus =
  'idle' | 'configured' | 'connecting' | 'connected' | 'online' | 'offline' | 'error' | 'stopped';

export interface NetworkDiagnostics {
  mode: NetworkMode;
  status: NetworkStatus;
  /** Backend de transport associé au mode (`none`, `fetch` ou `wisp`). */
  transport: NetworkTransportKind;
  /**
   * Vrai **uniquement** si la connectivité Internet a été vérifiée à
   * l'exécution (transport réellement `online`). Jamais déduit du mode.
   */
  verified: boolean;
  txBytes: number;
  rxBytes: number;
  lastError?: { code: NetworkErrorCode; message: string };
}
