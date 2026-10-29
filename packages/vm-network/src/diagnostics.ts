import type { NetworkTransportKind } from './capabilities';
import type { NetworkErrorCode } from './errors';
import type { NetworkMode } from './modes';

/** `configured` accepted the profile; `online` requires a proven probe. */
export type NetworkStatus =
  'idle' | 'configured' | 'connecting' | 'connected' | 'online' | 'offline' | 'error' | 'stopped';

export type NetworkProbeKind = 'dns' | 'http' | 'https' | 'tcp';

export interface NetworkProbeResult {
  ok: boolean;
  at: number;
  detail?: string;
}

export interface NetworkDiagnostics {
  mode: NetworkMode;
  status: NetworkStatus;
  transport: NetworkTransportKind;
  /** Only a successful `tcp` or `https` probe sets it; `dns`/`http` are not enough. */
  verified: boolean;
  txBytes: number;
  rxBytes: number;
  lastError?: { code: NetworkErrorCode; message: string };
  probes?: Partial<Record<NetworkProbeKind, NetworkProbeResult>>;
}
