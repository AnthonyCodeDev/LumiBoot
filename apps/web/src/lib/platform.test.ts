import { describe, expect, it } from 'vitest';
import { detectHostPlatform, detectHostPlatformAsync, type HostNavigator } from './platform';

function nav(userAgent: string): HostNavigator {
  return { userAgent };
}

describe('detectHostPlatform', () => {
  it('explicit Windows x64', () => {
    const platform = detectHostPlatform(
      nav('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'),
    );
    expect(platform).toEqual({ os: 'windows', arch: 'x64', key: 'windows-x64' });
  });

  it('explicit Windows ARM', () => {
    const platform = detectHostPlatform(
      nav('Mozilla/5.0 (Windows NT 10.0; ARM64) AppleWebKit/537.36 Chrome/120 Safari/537.36'),
    );
    expect(platform).toEqual({ os: 'windows', arch: 'arm64', key: 'windows-arm64' });
  });

  it('Windows without an architecture hint: unknown arch, no key', () => {
    const platform = detectHostPlatform(nav('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36'));
    expect(platform.os).toBe('windows');
    expect(platform.arch).toBe('unknown');
    expect(platform.key).toBeNull();
  });

  it('Intel Mac ("Intel" UA): unknown arch because ARM Macs also send "Intel"', () => {
    const platform = detectHostPlatform(
      nav(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      ),
    );
    expect(platform.os).toBe('macos');
    expect(platform.arch).toBe('unknown');
    expect(platform.key).toBe('macos');
  });

  it('ARM Mac (same "Intel" UA for compatibility): unknown arch, macos key', () => {
    const platform = detectHostPlatform(
      nav(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
      ),
    );
    expect(platform).toEqual({ os: 'macos', arch: 'unknown', key: 'macos' });
  });

  it('Linux x64', () => {
    const platform = detectHostPlatform(
      nav('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36'),
    );
    expect(platform).toEqual({ os: 'linux', arch: 'x64', key: 'linux-x64' });
  });

  it('Linux ARM', () => {
    const platform = detectHostPlatform(
      nav('Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 Chrome/120 Safari/537.36'),
    );
    expect(platform).toEqual({ os: 'linux', arch: 'arm64', key: 'linux-arm64' });
  });

  it('unknown browser: everything unknown, null key', () => {
    const platform = detectHostPlatform(nav('Mozilla/5.0 (compatible; Bot/1.0)'));
    expect(platform).toEqual({ os: 'unknown', arch: 'unknown', key: null });
  });
});

describe('detectHostPlatformAsync', () => {
  it('uses userAgentData when available (macOS ARM)', async () => {
    const fake: HostNavigator = {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      userAgentData: {
        getHighEntropyValues: async () => ({ platform: 'macOS', architecture: 'arm' }),
      },
    };
    const platform = await detectHostPlatformAsync(fake);
    expect(platform).toEqual({ os: 'macos', arch: 'arm64', key: 'macos' });
  });

  it('Windows x86 through userAgentData', async () => {
    const fake: HostNavigator = {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      userAgentData: {
        getHighEntropyValues: async () => ({ platform: 'Windows', architecture: 'x86' }),
      },
    };
    const platform = await detectHostPlatformAsync(fake);
    expect(platform).toEqual({ os: 'windows', arch: 'x64', key: 'windows-x64' });
  });

  it('synchronous fallback when getHighEntropyValues fails', async () => {
    const fake: HostNavigator = {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      userAgentData: {
        getHighEntropyValues: async () => {
          throw new Error('refused');
        },
      },
    };
    const platform = await detectHostPlatformAsync(fake);
    expect(platform).toEqual({ os: 'linux', arch: 'x64', key: 'linux-x64' });
  });
});
