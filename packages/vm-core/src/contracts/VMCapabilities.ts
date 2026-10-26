import type { Architecture } from '@lumiboot/contracts';

export type RuntimeTarget = 'browser';

/**
 * Features actually offered by an engine. A UI or an orchestrator must consult
 * `capabilities()` before offering snapshots, resume or partial download — not
 * all options are universal.
 */
export interface VMCapabilities {
  readonly runtime: RuntimeTarget;
  readonly architectures: readonly Architecture[];
  /** Full RAM + CPU snapshot. */
  readonly ramSnapshots: boolean;
  /** Disk-only snapshot, without the memory state. */
  readonly diskSnapshots: boolean;
  /** Partial download via HTTP Range requests. */
  readonly partialDownload: boolean;
  /** Resume of a previously interrupted session. */
  readonly resumable: boolean;
  /** Configurable guest memory. */
  readonly configurableMemory: boolean;
}

export const NO_CAPABILITIES: VMCapabilities = {
  runtime: 'browser',
  architectures: [],
  ramSnapshots: false,
  diskSnapshots: false,
  partialDownload: false,
  resumable: false,
  configurableMemory: false,
};
