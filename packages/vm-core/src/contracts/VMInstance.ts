import type { SessionEvent } from '@lumiboot/contracts';

/**
 * Virtual machine actually created by an engine.
 *
 * `dispose()` must always be called on unmount and after `stop()`: no WASM
 * worker must stay orphaned. A stopped instance is not yet released as long as
 * `dispose()` has not been called.
 */
export interface VMInstance {
  readonly id: string;
  readonly providerId: string;
  readonly systemId: string;
  stop(): Promise<void>;
  dispose(): Promise<void>;
  subscribe(listener: (event: SessionEvent) => void): () => void;
}
