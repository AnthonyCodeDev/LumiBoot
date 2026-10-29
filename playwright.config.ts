import { defineConfig, devices } from '@playwright/test';
// @ts-expect-error -- .mjs module without TypeScript types
import { loadEnvFile } from './scripts/lib/load-env.mjs';

loadEnvFile();

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 5200;

function parsePort(value: string | undefined, fallback: number): number {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === 'localhost';
}

/** Brackets IPv6 literals so they can be used in a URL. */
function urlHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

const host = process.env.E2E_HOST || DEFAULT_HOST;
const port = parsePort(process.env.E2E_PORT, DEFAULT_PORT);
const managedBaseURL = `http://${urlHost(host)}:${port}`;

// External `E2E_BASE_URL`: a non-loopback host means no managed webServer.
let baseURL = managedBaseURL;
let startWebServer = true;
const configuredBaseURL = process.env.E2E_BASE_URL?.trim();
if (configuredBaseURL !== undefined && configuredBaseURL.length > 0) {
  try {
    const parsed = new URL(configuredBaseURL);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      baseURL = parsed.href;
      startWebServer = isLoopbackHost(parsed.hostname);
    }
  } catch {
    // Malformed value: keep the managed loopback server.
  }
}

const webServer = startWebServer
  ? {
      command: `pnpm --filter @lumiboot/web dev --port ${port} --host ${host}`,
      url: managedBaseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    }
  : undefined;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  ...(webServer === undefined ? {} : { webServer }),
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
