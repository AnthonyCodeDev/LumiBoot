/**
 * Host platform detection for the local network proxy download.
 * When nothing proves the architecture, `arch` stays `'unknown'` and `key` is
 * `null`; a Mac is never assumed ARM64 nor Intel.
 */

export type HostOS = 'windows' | 'macos' | 'linux' | 'unknown';
export type HostArch = 'x64' | 'arm64' | 'unknown';
export type PlatformKey = 'windows-x64' | 'windows-arm64' | 'macos' | 'linux-x64' | 'linux-arm64';

export interface HostPlatform {
  os: HostOS;
  arch: HostArch;
  key: PlatformKey | null;
}

/** Subset of `Navigator` used by detection, injectable in tests. */
export interface HostNavigator {
  readonly userAgent?: string;
  readonly userAgentData?: {
    getHighEntropyValues?: (hints: string[]) => Promise<Record<string, string | undefined>>;
  } & Record<string, unknown>;
}

function resolveNavigator(nav?: HostNavigator): HostNavigator | undefined {
  if (nav !== undefined) return nav;
  if (typeof navigator !== 'undefined') return navigator as unknown as HostNavigator;
  return undefined;
}

function detectOS(userAgent: string): HostOS {
  const ua = userAgent.toLowerCase();
  if (ua.includes('windows')) return 'windows';
  if (ua.includes('mac os x') || ua.includes('macintosh') || ua.includes('macos')) return 'macos';
  // Android contains "linux": it is not a supported desktop host.
  if (ua.includes('android')) return 'unknown';
  if (ua.includes('linux')) return 'linux';
  return 'unknown';
}

/** Apple Silicon Macs send `Intel Mac OS X`, so macOS always yields `unknown`. */
function detectArchFromUA(userAgent: string, os: HostOS): HostArch {
  const ua = userAgent.toLowerCase();
  const hasArm =
    ua.includes('arm64') || ua.includes('aarch64') || /(^|[\s;()])arm([\s;()-]|$)/.test(ua);
  if (hasArm) return 'arm64';
  if (os === 'macos') return 'unknown';
  const hasX64 =
    ua.includes('x86_64') ||
    ua.includes('x64') ||
    ua.includes('amd64') ||
    ua.includes('win64') ||
    ua.includes('wow64');
  if (hasX64) return 'x64';
  return 'unknown';
}

function keyFor(os: HostOS, arch: HostArch): PlatformKey | null {
  if (os === 'macos') return 'macos';
  if (os === 'windows' && arch === 'x64') return 'windows-x64';
  if (os === 'windows' && arch === 'arm64') return 'windows-arm64';
  if (os === 'linux' && arch === 'x64') return 'linux-x64';
  if (os === 'linux' && arch === 'arm64') return 'linux-arm64';
  return null;
}

/** Synchronous detection from `userAgent` only. */
export function detectHostPlatform(nav?: HostNavigator): HostPlatform {
  const resolved = resolveNavigator(nav);
  const userAgent = resolved?.userAgent ?? '';
  const os = detectOS(userAgent);
  const arch = os === 'unknown' ? 'unknown' : detectArchFromUA(userAgent, os);
  return { os, arch, key: keyFor(os, arch) };
}

/**
 * Uses `userAgentData.getHighEntropyValues` when available, otherwise the
 * synchronous fallback. Chromium reports `x86` even on x86_64.
 */
export async function detectHostPlatformAsync(nav?: HostNavigator): Promise<HostPlatform> {
  const resolved = resolveNavigator(nav);
  const getValues = resolved?.userAgentData?.getHighEntropyValues;
  if (typeof getValues === 'function') {
    try {
      const values = await getValues.call(resolved?.userAgentData, ['architecture', 'platform']);
      const platform = (values?.['platform'] ?? '').toLowerCase();
      const architecture = (values?.['architecture'] ?? '').toLowerCase();
      const os: HostOS = platform.includes('windows')
        ? 'windows'
        : platform.includes('macos') || platform.includes('mac')
          ? 'macos'
          : platform === 'linux'
            ? 'linux'
            : 'unknown';
      let arch: HostArch = 'unknown';
      if (architecture.includes('arm')) arch = 'arm64';
      else if (architecture.includes('x86') || architecture.includes('64')) arch = 'x64';
      if (os !== 'unknown') return { os, arch, key: keyFor(os, arch) };
    } catch {
      // Fall back to the synchronous path.
    }
  }
  return detectHostPlatform(resolved);
}
