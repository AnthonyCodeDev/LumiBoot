import type { Architecture } from '@lumiboot/contracts';

export type RuntimeTarget = 'browser';

/** Consult `capabilities()` before offering snapshots, resume or partial download. */
export interface VMCapabilities {
  readonly runtime: RuntimeTarget;
  readonly architectures: readonly Architecture[];
  readonly ramSnapshots: boolean;
  readonly diskSnapshots: boolean;
  /** HTTP Range requests. */
  readonly partialDownload: boolean;
  readonly resumable: boolean;
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
