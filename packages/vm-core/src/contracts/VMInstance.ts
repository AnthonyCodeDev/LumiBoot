import type { SessionEvent } from '@lumiboot/contracts';

/**
 * Machine virtuelle réellement créée par un moteur.
 *
 * `dispose()` doit toujours être appelé au démontage et après `stop()` : aucun
 * worker WASM ne doit rester orphelin. Une instance arrêtée n'est pas encore
 * libérée tant que `dispose()` n'a pas été appelé.
 */
export interface VMInstance {
  readonly id: string;
  readonly providerId: string;
  readonly systemId: string;
  stop(): Promise<void>;
  dispose(): Promise<void>;
  subscribe(listener: (event: SessionEvent) => void): () => void;
}
