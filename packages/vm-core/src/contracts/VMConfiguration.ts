import type { VMMedia } from '@lumiboot/contracts';
import type { NetworkProfile } from '@lumiboot/vm-network';

/** All optional; engines apply their defaults. */
export interface VMConfiguration {
  readonly memoryMiB?: number;
  readonly vgaMemoryMiB?: number;
  readonly bootDevice?: string;
  /** Imported blob media for a BIOS start; resolved by the front-end. */
  readonly media?: VMMedia;
  readonly extra?: Readonly<Record<string, string | number | boolean>>;
  readonly network?: NetworkProfile;
  readonly signal?: AbortSignal;
}
