import type { SessionEvent } from '@lumiboot/contracts';

/** `dispose()` must follow `stop()`: a stopped instance is not released yet. */
export interface VMInstance {
  readonly id: string;
  readonly providerId: string;
  readonly systemId: string;
  stop(): Promise<void>;
  dispose(): Promise<void>;
  subscribe(listener: (event: SessionEvent) => void): () => void;
}
