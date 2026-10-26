import type { Availability } from '@lumiboot/contracts';

/**
 * Objective facts used to compute the effective availability of a system.
 *
 * None of these facts is a status "declared" by an image or a profile:
 * availability is always DERIVED from these four conditions.
 */
export interface SystemAvailabilityFacts {
  /** An image is really present/referenced (`imageRef` set). */
  readonly hasImage: boolean;
  /** At least one compatible launch profile (browser mode) exists. */
  readonly hasCompatibleProfile: boolean;
  /** The profile's engine is really integrated in the repository. */
  readonly engineIntegrated: boolean;
  /** Operation was validated by a proven real boot. */
  readonly validated: boolean;
  /**
   * The system media must be supplied by the user (no resource distributed).
   * Honesty factor: as long as `hasImage` is false, the effective state becomes
   * `resource-required` instead of an undifferentiated `planned`.
   */
  readonly requiresUserMedia?: boolean;
  /** Fallback status when the conditions are not met. */
  readonly declared?: Availability;
}

/**
 * SINGLE AVAILABILITY RULE.
 *
 * A system is available (`ready`) only if ALL these conditions are met: image
 * present/referenced, compatible profile, integrated engine and validated
 * operation. A system therefore does NOT become available just because its
 * image exists.
 *
 * Without proof, we never fall back to `ready`: a declared `ready` status is
 * downgraded to `planned`.
 */
export function getEffectiveAvailability(facts: SystemAvailabilityFacts): Availability {
  const available =
    facts.hasImage && facts.hasCompatibleProfile && facts.engineIntegrated && facts.validated;
  if (available) return 'ready';

  const declared = facts.declared ?? 'planned';
  // A declared but unproven `ready` is always downgraded.
  if (declared === 'ready') return 'planned';
  // A required user media that has not been imported yet is a state of its own:
  // the system is integrated, only the media is missing. It is disguised neither
  // as `ready` (false promise) nor as `planned` (loss of information).
  if (facts.requiresUserMedia === true && declared === 'planned') return 'resource-required';
  return declared;
}

/**
 * Aggregates the availability of SEVERAL candidates — a candidate being a
 * consistent triple (image × profile × engine).
 *
 * Audit #19 fix: a system's availability must NEVER combine the validation of
 * one profile with the engine (or compatibility) of another. A system is
 * therefore `ready` only if the SAME candidate meets all four conditions;
 * independent `some()` calls could produce a false `ready`.
 *
 * The business rule is unchanged: `ready` requires a really validated boot.
 */
export function getAggregatedAvailability(
  candidates: readonly SystemAvailabilityFacts[],
): Availability {
  if (candidates.length === 0) return 'planned';

  const effective = candidates.map((facts) => getEffectiveAvailability(facts));
  if (effective.includes('ready')) return 'ready';
  // `resource-required` wins over `planned`: the "media to supply" information
  // must never be hidden by a more generic state.
  if (effective.includes('resource-required')) return 'resource-required';

  const declared = candidates.find((facts) => facts.declared !== undefined)?.declared;
  return declared !== undefined && declared !== 'ready' ? declared : 'planned';
}
