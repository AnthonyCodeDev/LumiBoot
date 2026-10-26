import type { VMMedia } from '@lumiboot/contracts';
import type { NetworkProfile } from '@lumiboot/vm-network';

/**
 * Start parameters of a virtual machine. All optional: the engine applies its
 * defaults when they are absent.
 */
export interface VMConfiguration {
  readonly memoryMiB?: number;
  readonly vgaMemoryMiB?: number;
  readonly bootDevice?: string;
  /**
   * Disk media imported by the user (local blob URL) for a BIOS start, without
   * a Linux kernel. Resolved at start time by the front-end.
   */
  readonly media?: VMMedia;
  readonly extra?: Readonly<Record<string, string | number | boolean>>;
  readonly network?: NetworkProfile;
  readonly signal?: AbortSignal;
}
