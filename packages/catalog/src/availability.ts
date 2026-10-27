import type { Availability } from '@lumiboot/contracts';

/** Objective facts; availability is always derived, never declared. */
export interface SystemAvailabilityFacts {
  /** An image is referenced. */
  readonly hasImage: boolean;
  readonly hasCompatibleProfile: boolean;
  readonly engineIntegrated: boolean;
  readonly validated: boolean;
  /** Keeps the state `resource-required` rather than a bare `planned`. */
  readonly requiresUserMedia?: boolean;
  /** Fallback status when the conditions are not met. */
  readonly declared?: Availability;
}

/**
 * `ready` requires all four facts; a declared `ready` without proof is
 * downgraded to `planned`.
 */
export function getEffectiveAvailability(facts: SystemAvailabilityFacts): Availability {
  const available =
    facts.hasImage && facts.hasCompatibleProfile && facts.engineIntegrated && facts.validated;
  if (available) return 'ready';

  const declared = facts.declared ?? 'planned';
  // A declared but unproven `ready` is always downgraded.
  if (declared === 'ready') return 'planned';
  // The system is integrated, only the media is missing.
  if (facts.requiresUserMedia === true && declared === 'planned') return 'resource-required';
  return declared;
}

/**
 * Each candidate is a consistent image/profile/engine triple, so validation of
 * one profile is never combined with another engine.
 */
export function getAggregatedAvailability(
  candidates: readonly SystemAvailabilityFacts[],
): Availability {
  if (candidates.length === 0) return 'planned';

  const effective = candidates.map((facts) => getEffectiveAvailability(facts));
  if (effective.includes('ready')) return 'ready';
  // `resource-required` wins over the more generic `planned`.
  if (effective.includes('resource-required')) return 'resource-required';

  const declared = candidates.find((facts) => facts.declared !== undefined)?.declared;
  return declared !== undefined && declared !== 'ready' ? declared : 'planned';
}
