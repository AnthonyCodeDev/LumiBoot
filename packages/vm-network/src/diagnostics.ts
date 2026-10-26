import type { NetworkTransportKind } from './capabilities';
import type { NetworkErrorCode } from './errors';
import type { NetworkMode } from './modes';

/**
 * State of the network subsystem of a session.
 *
 * Semantics (each state describes a distinct step, never confused):
 *
 * - `idle`       : controller created, `start()` not called yet.
 * - `offline`    : offline mode; **no transport** is established.
 * - `configured` : the profile was **accepted** (syntactically valid relay), but
 *                  **the transport is not established yet**. This is the default
 *                  state returned by `start()` for a mode with a transport: a
 *                  valid relay URL proves nothing more.
 * - `connecting` : the transport really started connecting (reported by the
 *                  provider, never inferred from the mode).
 * - `connected`  : the transport is established, **only** when the provider
 *                  reports it through `setStatus('connected')`. Never automatic.
 * - `online`     : the transport is established **and** Internet connectivity was
 *                  **verified at runtime** (`verified === true`, i.e. a
 *                  successful **`tcp`/`https` probe**). Never inferred from the
 *                  mode, from a syntactically correct address, or from
 *                  `setStatus` alone.
 * - `error`      : a normalized error was recorded (`lastError`).
 * - `stopped`    : explicit stop/disposal.
 */
export type NetworkStatus =
  'idle' | 'configured' | 'connecting' | 'connected' | 'online' | 'offline' | 'error' | 'stopped';

/** Kind of a **real network probe** run at runtime. */
export type NetworkProbeKind = 'dns' | 'http' | 'https' | 'tcp';

/**
 * Result of a network probe, **supplied by the provider**. `at` is the
 * measurement timestamp (ms); `detail` carries an optional human-readable
 * reason.
 */
export interface NetworkProbeResult {
  ok: boolean;
  at: number;
  detail?: string;
}

export interface NetworkDiagnostics {
  mode: NetworkMode;
  status: NetworkStatus;
  /** Transport backend associated with the mode (`none`, `fetch` or `wisp`). */
  transport: NetworkTransportKind;
  /**
   * True **only** on **real proof**: a successful `tcp` or `https` probe
   * (`ok`). This is a **verified feature** (runtime), fed by the provider, and
   * **never** inferred from the mode or from a mere transport selection. `dns`/
   * `http` probes are not enough.
   */
  verified: boolean;
  txBytes: number;
  rxBytes: number;
  lastError?: { code: NetworkErrorCode; message: string };
  /**
   * Last known probe per kind. Optional: absent as long as no probe has been
   * reported.
   */
  probes?: Partial<Record<NetworkProbeKind, NetworkProbeResult>>;
}
