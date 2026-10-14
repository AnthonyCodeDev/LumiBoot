import type { NetworkMode } from './modes';
import type { NetworkErrorCode } from './errors';

export type NetworkStatus = 'idle' | 'starting' | 'connected' | 'offline' | 'error' | 'stopped';

export interface NetworkDiagnostics {
  mode: NetworkMode;
  status: NetworkStatus;
  txBytes: number;
  rxBytes: number;
  lastError?: { code: NetworkErrorCode; message: string };
}
