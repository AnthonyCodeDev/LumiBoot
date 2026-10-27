import type { OSDefinition } from '@lumiboot/contracts';
import type { VMCapabilities } from './VMCapabilities';
import type { VMConfiguration } from './VMConfiguration';
import type { VMInstance } from './VMInstance';

/** Only entry point to start a system; `canRun` must stay deterministic. */
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
