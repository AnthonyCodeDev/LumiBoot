import type { VMState } from '@lumiboot/contracts';

/**
 * Transitions autorisées de la machine à états d'une session.
 *
 * INVARIANT : une seule transition `booting -> running`, déclenchée par la
 * preuve que le système invité est opérationnel — jamais par un minuteur.
 */
export const allowedTransitions: Record<VMState, readonly VMState[]> = {
  idle: ['preparing', 'error'],
  preparing: ['downloading', 'booting', 'stopping', 'error'],
  downloading: ['booting', 'stopping', 'error'],
  booting: ['running', 'stopping', 'error'],
  running: ['stopping', 'error'],
  stopping: ['stopped', 'error'],
  stopped: ['preparing', 'idle'],
  error: ['preparing', 'idle'],
};
