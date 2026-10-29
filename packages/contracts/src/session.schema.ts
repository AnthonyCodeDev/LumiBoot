import { z } from 'zod';

/** `booting -> running` must be proven by the real guest boot, never a timer. */
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

/** Duplicated from `@lumiboot/vm-network`: contracts cannot depend on it. */
export const networkModeSchema = z.enum([
  'offline',
  'browser-fetch',
  'local-proxy',
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

/** Mirror of the `vm-network` probe kinds. */
export const networkProbeKindSchema = z.enum(['dns', 'http', 'https', 'tcp']);

export const networkProbeResultSchema = z.object({
  ok: z.boolean(),
  at: z.number(),
  detail: z.string().min(1).optional(),
});

export const networkDiagnosticsSchema = z.object({
  mode: networkModeSchema,
  status: networkStatusSchema,
  transport: networkTransportSchema,
  verified: z.boolean(),
  txBytes: z.number().nonnegative(),
  rxBytes: z.number().nonnegative(),
  lastError: z.object({ code: z.string().min(1), message: z.string().min(1) }).optional(),
  probes: z.partialRecord(networkProbeKindSchema, networkProbeResultSchema).optional(),
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
export type NetworkProbeKind = z.infer<typeof networkProbeKindSchema>;
export type NetworkProbeResult = z.infer<typeof networkProbeResultSchema>;
export type NetworkDiagnostics = z.infer<typeof networkDiagnosticsSchema>;
export type SessionEvent = z.infer<typeof sessionEventSchema>;
