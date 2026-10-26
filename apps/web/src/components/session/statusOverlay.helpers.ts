import type { SessionSnapshot } from '@lumiboot/vm-core';

export interface StatusMessage {
  title: string;
  detail?: string;
}

/**
 * Plain message for non-boot states (stopping, idle).
 * These states show neither a log nor progress.
 */
export function statusMessageForSession(session: SessionSnapshot): StatusMessage {
  switch (session.state) {
    case 'stopping':
      return { title: 'Stopping…', detail: 'The session is closing.' };
    case 'stopped':
      return { title: 'System stopped', detail: 'The session has been stopped.' };
    case 'idle':
    default:
      return { title: 'Session idle', detail: 'No session is running.' };
  }
}

export function statusTextForSession(session: SessionSnapshot): string {
  switch (session.state) {
    case 'downloading':
      return 'Loading resources…';
    case 'booting':
      return 'Starting the system…';
    case 'running':
      return 'Session running.';
    case 'stopped':
      return 'Session stopped.';
    case 'stopping':
      return 'Stopping the session…';
    case 'preparing':
    case 'idle':
    default:
      return 'Preparing the session…';
  }
}
