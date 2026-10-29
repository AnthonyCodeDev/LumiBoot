import { describe, expect, it, vi } from 'vitest';
import {
  DISCORD_INVITE_URL,
  httpsUrl,
  loopbackProxyUrl,
  readEnv,
  sameOriginPath,
} from './environment';
import { TEST_PROXY_URL } from '../test/fixtures';

/** A name that is never set in the test environment. */
const UNSET = 'VITE_LUMIBOOT_TEST_UNSET' as keyof ImportMetaEnv;

/** Re-imports the module so `ENV` captures the stubbed `import.meta.env`. */
async function readStubbed(name: string, value: string): Promise<string> {
  vi.stubEnv(name, value);
  vi.resetModules();
  try {
    const fresh = await import('./environment');
    return fresh.readEnv(name as keyof ImportMetaEnv, '/fallback.json');
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
  }
}

describe('readEnv', () => {
  it('falls back when the variable is missing', () => {
    expect(readEnv(UNSET, '/fallback.json')).toBe('/fallback.json');
  });

  it('falls back when the variable is blank', async () => {
    expect(await readStubbed('VITE_LUMIBOOT_CONFIG_URL', '   ')).toBe('/fallback.json');
    expect(await readStubbed('VITE_LUMIBOOT_CONFIG_URL', '')).toBe('/fallback.json');
  });

  it('trims a configured value', async () => {
    expect(await readStubbed('VITE_LUMIBOOT_CONFIG_URL', '  /custom.json  ')).toBe('/custom.json');
  });
});

describe('sameOriginPath', () => {
  it('keeps a valid absolute same-origin path', () => {
    expect(sameOriginPath('/lumiboot.config.json', '/fallback')).toBe('/lumiboot.config.json');
    expect(sameOriginPath('/a/b/c?x=1', '/fallback')).toBe('/a/b/c?x=1');
  });

  it('rejects protocol-relative and absolute URLs', () => {
    expect(sameOriginPath('//evil.example/config.json', '/fallback')).toBe('/fallback');
    expect(sameOriginPath('/\\evil.example/config.json', '/fallback')).toBe('/fallback');
    expect(sameOriginPath('https://evil.example/config.json', '/fallback')).toBe('/fallback');
  });

  it('rejects whitespace, control characters and empty values', () => {
    expect(sameOriginPath('', '/fallback')).toBe('/fallback');
    expect(sameOriginPath(' /config.json', '/fallback')).toBe('/fallback');
    expect(sameOriginPath('/config .json', '/fallback')).toBe('/fallback');
    expect(sameOriginPath('/config\n.json', '/fallback')).toBe('/fallback');
    expect(sameOriginPath('config.json', '/fallback')).toBe('/fallback');
  });
});

describe('loopbackProxyUrl', () => {
  const fallback = TEST_PROXY_URL;

  it('keeps a custom loopback proxy URL', () => {
    expect(loopbackProxyUrl('http://127.0.0.1:4000', fallback)).toBe('http://127.0.0.1:4000');
    expect(loopbackProxyUrl('https://localhost:4443', fallback)).toBe('https://localhost:4443');
    expect(loopbackProxyUrl('http://[::1]:37892', fallback)).toBe('http://[::1]:37892');
  });

  it('rejects a non-loopback proxy URL', () => {
    expect(loopbackProxyUrl('https://evil.example:37892', fallback)).toBe(fallback);
    expect(loopbackProxyUrl('http://0.0.0.0:37892', fallback)).toBe(fallback);
    expect(loopbackProxyUrl('ws://127.0.0.1:37892', fallback)).toBe(fallback);
    expect(loopbackProxyUrl('not a url', fallback)).toBe(fallback);
  });
});

describe('httpsUrl', () => {
  const fallback = 'https://fallback.example/invite';

  it('keeps a valid https URL', () => {
    expect(httpsUrl('https://discord.gg/abc', fallback)).toBe('https://discord.gg/abc');
    expect(httpsUrl('  https://example.com/a/b?c=1  ', fallback)).toBe(
      'https://example.com/a/b?c=1',
    );
  });

  it('rejects a non-https scheme', () => {
    expect(httpsUrl('http://discord.gg/abc', fallback)).toBe(fallback);
    expect(httpsUrl('javascript:alert(1)', fallback)).toBe(fallback);
    expect(httpsUrl('ftp://discord.gg/abc', fallback)).toBe(fallback);
  });

  it('rejects a URL carrying credentials', () => {
    expect(httpsUrl('https://user:pass@host.example/', fallback)).toBe(fallback);
    expect(httpsUrl('https://user@host.example/', fallback)).toBe(fallback);
  });

  it('rejects empty, blank and unparsable values', () => {
    expect(httpsUrl('', fallback)).toBe(fallback);
    expect(httpsUrl('   ', fallback)).toBe(fallback);
    expect(httpsUrl('not a url', fallback)).toBe(fallback);
    expect(httpsUrl('https://exa mple.com/', fallback)).toBe(fallback);
  });
});

describe('DISCORD_INVITE_URL', () => {
  it('is the built-in invitation by default', () => {
    expect(DISCORD_INVITE_URL.startsWith('https://discord.gg/')).toBe(true);
    expect(DISCORD_INVITE_URL).not.toContain('@');
  });

  it('falls back to the built-in invitation when the variable is unusable', async () => {
    for (const value of ['http://insecure.example/invite', '']) {
      vi.stubEnv('VITE_DISCORD_INVITE_URL', value);
      vi.resetModules();
      try {
        const fresh = await import('./environment');
        expect(fresh.DISCORD_INVITE_URL).toBe(DISCORD_INVITE_URL);
      } finally {
        vi.unstubAllEnvs();
        vi.resetModules();
      }
    }
  });
});
