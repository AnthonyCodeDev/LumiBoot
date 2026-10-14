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
]);

export type VMState = z.infer<typeof vmStateSchema>;
export type SessionEvent = z.infer<typeof sessionEventSchema>;
