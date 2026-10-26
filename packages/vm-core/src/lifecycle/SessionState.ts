import type { VMState } from '@lumiboot/contracts';

/**
 * Allowed transitions of a session state machine.
 *
 * INVARIANT: a single `booting -> running` transition, triggered by proof that
 * the guest system is operational — never by a timer.
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
