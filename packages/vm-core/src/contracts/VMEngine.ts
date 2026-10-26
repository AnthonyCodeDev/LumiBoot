import type { OSDefinition } from '@lumiboot/contracts';
import type { VMCapabilities } from './VMCapabilities';
import type { VMConfiguration } from './VMConfiguration';
import type { VMInstance } from './VMInstance';

/**
 * Single contract of an emulation/virtualization engine. It is the only entry
 * point to start a system: the UI never knows about `new V86(...)`.
 *
 * `canRun` must stay deterministic and explicit; device compatibility checks are
 * handled separately by `EngineCompatibility`.
 */
export interface VMEngine {
  readonly id: string;
  capabilities(): VMCapabilities;
  canRun(os: OSDefinition): boolean;
  start(
    os: OSDefinition,
    mountTarget: unknown,
    configuration?: VMConfiguration,
  ): Promise<VMInstance>;
}

/** @deprecated Use `VMEngine`. Kept for import compatibility. */
export type VMProvider = VMEngine;
