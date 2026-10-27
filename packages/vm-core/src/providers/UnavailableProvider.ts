import type { OSDefinition, SessionEvent } from '@lumiboot/contracts';
import { VMError } from '../errors/VMError';
import { createSessionId } from '../ids';
import { NO_CAPABILITIES, type VMCapabilities } from '../contracts/VMCapabilities';
import type { VMEngine } from '../contracts/VMEngine';
import type { VMInstance } from '../contracts/VMInstance';

export const UNAVAILABLE_PROVIDER_ID = 'unavailable';

/** The first subscriber receives a typed error; no progress is simulated. */
export function createErrorHandle(
  providerId: string,
  systemId: string,
  error: VMError,
  id: string = createSessionId(),
): VMInstance {
  const listeners = new Set<(event: SessionEvent) => void>();
  const emit = (event: SessionEvent): void => {
    for (const listener of listeners) listener(event);
  };

  return {
    id,
    providerId,
    systemId,
    async stop(): Promise<void> {
      emit({ type: 'state', state: 'stopped' });
    },
    async dispose(): Promise<void> {
      listeners.clear();
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      listener({ type: 'error', code: error.code, message: error.message });
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Fallback engine: never renders a fake VM. */
export class UnavailableProvider implements VMEngine {
  readonly id = UNAVAILABLE_PROVIDER_ID;

  capabilities(): VMCapabilities {
    return NO_CAPABILITIES;
  }

  canRun(_os: OSDefinition): boolean {
    return true;
  }

  async start(os: OSDefinition): Promise<VMInstance> {
    const launchProfile = os.launchProfiles[0];
    const engineLabel = launchProfile ? launchProfile.engineId : 'unknown';
    const error = new VMError(
      'ENGINE_NOT_INTEGRATED',
      `Engine "${engineLabel}" is not yet integrated. No system was started.`,
      { systemId: os.id },
    );
    return createErrorHandle(this.id, os.id, error);
  }
}
