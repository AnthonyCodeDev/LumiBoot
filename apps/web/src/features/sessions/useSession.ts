import type { SessionSnapshot } from '@lumiboot/vm-core';
import { useSessionsStore } from './sessions.store';

export function useSession(id: string | undefined): SessionSnapshot | undefined {
  return useSessionsStore((state) => (id ? state.sessions[id] : undefined));
}
