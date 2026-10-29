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
  /** Has the media required by a `user-import` system actually been imported? */
  userMediaReady?: boolean;
}

/** Stable user message per cause; a raw technical reason is never shown. */
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
  'range-intercepted':
    'A cached response or a service worker answers the disk with the whole file instead of HTTP ranges: clear the site data, then retry.',
  unauthorized: 'Access to the media was refused by the server.',
  network: 'The media is unreachable (network error).',
  aborted: 'The media availability check was aborted.',
};

/** Declared-side source of truth for the "Start session" button. */
export function getLaunchReadiness(
  system: OSDefinition,
  options: LaunchReadinessOptions = {},
): LaunchReadiness {
  if (system.availability === 'unavailable') {
    return { canLaunch: false, reason: 'This system is marked as unavailable.' };
  }

  const profile = getPrimaryLaunchProfile(system);
  const declared = getDeclaredReadiness(system);

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

  const memoryReason = getMemoryConstraintReason(system, profile);
  if (memoryReason !== null) return { canLaunch: false, reason: memoryReason };

  const compatibility = explainSystemCompatibility(system);
  if (!compatibility.compatible) {
    return { canLaunch: false, reason: compatibility.reasons.join(' ') };
  }

  return { canLaunch: true };
}

/** Configured memory must reach the declared minimum. */
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

export interface RuntimeCheckOptions {
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}

/** Result of a runtime media availability check. */
export interface RuntimeAvailability {
  readonly available: boolean;
  readonly reason?: string;
  /** Disk size announced by the server via `Content-Range`, when known. */
  readonly size?: number;
}

/** A `user-import` system is skipped: its media is local. */
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
