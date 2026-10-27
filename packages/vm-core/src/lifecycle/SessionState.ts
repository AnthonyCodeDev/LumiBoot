import type { VMState } from '@lumiboot/contracts';

/** `booting -> running` is triggered by a guest proof, never by a timer. */
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
