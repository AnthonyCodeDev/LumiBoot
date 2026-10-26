import type { LaunchProfile, OSDefinition } from '@lumiboot/contracts';
import {
  checkImageAvailability,
  checkLocalDiskAvailability,
  ASSET_UNAVAILABLE_MESSAGES,
  type AssetAvailabilityOptions,
  type AssetUnavailableReason,
} from '@lumiboot/vm-assets';
import { getDeclaredReadiness } from '@lumiboot/catalog';
import { isEngineIntegrated } from './compatibility';
import { getPrimaryLaunchProfile } from './labels';
import { explainSystemCompatibility } from '../features/sessions/registry';

export interface LaunchReadiness {
  canLaunch: boolean;
  reason?: string;
}

export interface LaunchReadinessOptions {
  /**
   * Has the local media required by a `user-import` system actually been imported
   * (bytes available)? Provided by the user media store.
   */
  userMediaReady?: boolean;
}

/**
 * Stable user message per runtime unavailability cause. A raw technical reason is
 * never shown: every cause (404, SPA HTML fallback, missing HTTP Range…) has an
 * actionable explanation. The "file not published" causes reuse the canonical
 * strings of `@lumiboot/vm-assets`, so both layers cannot drift apart.
 */
const RUNTIME_REASON_MESSAGES: Record<AssetUnavailableReason, string> = {
  'ref-invalid': 'The system media reference is invalid.',
  'manifest-missing': ASSET_UNAVAILABLE_MESSAGES['manifest-missing'],
  'manifest-html':
    'The server returned an HTML page (SPA fallback) instead of the media JSON manifest.',
  'manifest-invalid': 'The media manifest is not readable JSON.',
  'manifest-schema': 'The media manifest does not match the expected schema.',
  'ref-mismatch': 'The manifest reference does not match the requested system.',
  'disk-missing': ASSET_UNAVAILABLE_MESSAGES['disk-missing'],
  'disk-html': 'The server returned an HTML page (SPA fallback) instead of the disk file.',
  'disk-mismatch': 'The served disk size does not match the one announced by the manifest.',
  'range-unsupported':
    'The server does not serve the disk over HTTP Range (206): v86 cannot read it in ranges.',
  unauthorized: 'Access to the media was refused by the server.',
  network: 'The media is unreachable (network error).',
  aborted: 'The media availability check was aborted.',
};

/**
 * Source of truth for enabling the "Start session" button, on the DECLARED side
 * (catalogue) plus static constraints.
 *
 * - **Local disk** system (`readiness.mode === 'disk-boot'`, e.g. Windows 7):
 *   launchable once the engine is integrated, a disk is referenced
 *   (`imageRef`), the allocated memory is consistent and the architecture is
 *   served by the engine. No media is imported or requested: the disk belongs to
 *   the codebase and is served locally. Its real presence is checked at runtime
 *   by `checkSystemRuntimeAvailability`.
 * - `bundled` system: launchable when the catalogue entry is `ready`, the main
 *   engine is integrated and the architecture is served.
 * - `user-import` system: launchable once the user imported THEIR legal
 *   media — never before.
 *
 * An unserved architecture (e.g. `x86_64`/`arm64` under v86) and a missing
 * integrated engine are refused EXPLICITLY here, before any boot.
 */
export function getLaunchReadiness(
  system: OSDefinition,
  options: LaunchReadinessOptions = {},
): LaunchReadiness {
  if (system.availability === 'unavailable') {
    return { canLaunch: false, reason: 'This system is marked as unavailable.' };
  }

  const profile = getPrimaryLaunchProfile(system);
  const declared = getDeclaredReadiness(system);

  // 1. Checks tied to the media source.
  if (declared.mediaSource === 'user-import') {
    if (!isEngineIntegrated(profile.engineId)) {
      return {
        canLaunch: false,
        reason: `The "${profile.engineId}" engine is not integrated.`,
      };
    }
    if (!options.userMediaReady) {
      return {
        canLaunch: false,
        reason:
          'Resource required: import a disk media you own legally to start this ' +
          'session. LumiBoot distributes no images.',
      };
    }
  } else if (declared.mediaSource === 'local-disk') {
    if (!isEngineIntegrated(profile.engineId)) {
      return {
        canLaunch: false,
        reason: `The "${profile.engineId}" engine is not integrated.`,
      };
    }
    if (!system.imageRef) {
      return {
        canLaunch: false,
        reason: 'No local disk is associated with this system.',
      };
    }
  } else {
    if (system.availability !== 'ready') {
      return {
        canLaunch: false,
        reason: 'This system is not ready: its engine and image are not available.',
      };
    }
    if (!isEngineIntegrated(profile.engineId)) {
      return {
        canLaunch: false,
        reason: `The "${profile.engineId}" engine is not integrated.`,
      };
    }
  }

  // 2. Declared memory constraint (profile consistency / allocated memory).
  const memoryReason = getMemoryConstraintReason(system, profile);
  if (memoryReason !== null) return { canLaunch: false, reason: memoryReason };

  // 3. Runtime architecture/CPU compatibility + browser prerequisites. An engine
  //    that does not serve the system architecture is refused here, not at boot.
  const compatibility = explainSystemCompatibility(system);
  if (!compatibility.compatible) {
    return { canLaunch: false, reason: compatibility.reasons.join(' ') };
  }

  return { canLaunch: true };
}

/**
 * Static memory constraint: the configured memory must be set and at least equal
 * to the profile's declared minimum. Both values come from the catalogue; this
 * check stops an inconsistent profile from promising a boot it cannot deliver.
 */
function getMemoryConstraintReason(system: OSDefinition, profile: LaunchProfile): string | null {
  const configured = profile.configuration?.memoryMiB ?? system.minMemoryMiB;
  if (configured === undefined || configured <= 0) {
    return 'Guest memory is not set: the launch cannot be guaranteed.';
  }
  const minimum = profile.minMemoryMiB;
  if (minimum !== undefined && configured < minimum) {
    return `Insufficient guest memory: ${configured} MiB allocated for ${minimum} MiB required.`;
  }
  return null;
}

/** Options for the runtime availability check (injectable in tests). */
export interface RuntimeCheckOptions {
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}

/** Result of a runtime media availability check. */
export interface RuntimeAvailability {
  readonly available: boolean;
  readonly reason?: string;
  /** Disk size announced by the server (`Content-Range`), when known. */
  readonly size?: number;
}

/**
 * Checks that the DECLARED media of a system is really servable right now: valid
 * JSON manifest, consistent reference and disk served over HTTP Range
 * (206 + `Content-Range`). Separate from catalogue availability: a declared
 * `ready` may well map to a missing disk (gitignored), to an SPA HTML fallback or
 * to a server ignoring Range.
 *
 * For a `user-import` system, the media is local (browser blob): it is never
 * checked over HTTP — only the imported presence (`userMediaReady`) matters,
 * checked by the caller.
 */
export async function checkSystemRuntimeAvailability(
  system: OSDefinition,
  options: RuntimeCheckOptions = {},
): Promise<RuntimeAvailability> {
  const declared = getDeclaredReadiness(system);
  if (declared.mediaSource === 'user-import') return { available: true };

  const ref = system.imageRef;
  if (!ref) {
    return { available: false, reason: 'No media is associated with this system.' };
  }

  const assetOptions: AssetAvailabilityOptions = {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  };

  const result =
    declared.mediaSource === 'local-disk'
      ? await checkLocalDiskAvailability(ref, assetOptions)
      : await checkImageAvailability(ref, assetOptions);

  if (result.available) {
    return { available: true, ...(result.size === undefined ? {} : { size: result.size }) };
  }
  const reason =
    result.message ??
    RUNTIME_REASON_MESSAGES[result.reason ?? 'network'] ??
    'The system media is unavailable.';
  return { available: false, reason };
}

/**
 * COMPLETE readiness of the launch button: first the declared constraints
 * (catalogue, engine, architecture, memory, imported media), then the runtime
 * availability (manifest + HTTP Range disk). Returns the first explicit refusal
 * reason.
 */
export async function resolveLaunchReadiness(
  system: OSDefinition,
  options: LaunchReadinessOptions & RuntimeCheckOptions = {},
): Promise<LaunchReadiness> {
  const declared = getLaunchReadiness(system, {
    ...(options.userMediaReady === undefined ? {} : { userMediaReady: options.userMediaReady }),
  });
  if (!declared.canLaunch) return declared;

  const runtime = await checkSystemRuntimeAvailability(system, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  if (!runtime.available) {
    return {
      canLaunch: false,
      reason: runtime.reason ?? 'The system media is unavailable.',
    };
  }
  return { canLaunch: true };
}
