import { z } from 'zod';

/**
 * Cycle de vie d'une session de machine virtuelle.
 *
 * L'unique transition `booting -> running` doit être prouvée par le démarrage
 * réel du système invité, jamais par un minuteur JavaScript.
 */
export const vmStateSchema = z.enum([
  'idle',
  'preparing',
  'downloading',
  'booting',
  'running',
  'stopping',
  'stopped',
  'error',
]);

/**
 * Diagnostic réseau d'une session. Ces valeurs sont volontairement dupliquées
 * depuis `@lumiboot/vm-network` : `contracts` est la couche la plus basse et ne
 * peut pas dépendre du sous-système réseau (qui, lui, dépend de `contracts`).
 */
export const networkModeSchema = z.enum([
  'offline',
  'browser-fetch',
  'user-relay',
  'local-network',
]);

export const networkStatusSchema = z.enum([
  'idle',
  'configured',
  'connecting',
  'connected',
  'online',
  'offline',
  'error',
  'stopped',
]);

export const networkTransportSchema = z.enum(['none', 'fetch', 'wisp']);

export const networkDiagnosticsSchema = z.object({
  mode: networkModeSchema,
  status: networkStatusSchema,
  transport: networkTransportSchema,
  verified: z.boolean(),
  txBytes: z.number().nonnegative(),
  rxBytes: z.number().nonnegative(),
  lastError: z.object({ code: z.string().min(1), message: z.string().min(1) }).optional(),
});

export const sessionEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('state'), state: vmStateSchema }),
  z.object({
    type: z.literal('progress'),
    phase: z.string().min(1),
    loadedBytes: z.number().nonnegative().optional(),
    totalBytes: z.number().nonnegative().optional(),
  }),
  z.object({
    type: z.literal('error'),
    code: z.string().min(1),
    message: z.string().min(1),
  }),
  z.object({ type: z.literal('network'), network: networkDiagnosticsSchema }),
]);

export type VMState = z.infer<typeof vmStateSchema>;
export type NetworkMode = z.infer<typeof networkModeSchema>;
export type NetworkStatus = z.infer<typeof networkStatusSchema>;
export type NetworkTransport = z.infer<typeof networkTransportSchema>;
export type NetworkDiagnostics = z.infer<typeof networkDiagnosticsSchema>;
export type SessionEvent = z.infer<typeof sessionEventSchema>;
