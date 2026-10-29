import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
// Untyped ESM module: serves local RAW disks over HTTP Range (dev).
// @ts-expect-error -- .mjs module without TypeScript types
import { createDiskAssetMiddleware } from '../../scripts/lib/disk-asset-dev.mjs';

/** Repository root, relative to the Vite root (`apps/web`). */
const ENV_DIR = '../..';
const DEFAULT_PORT = 5173;

function parsePort(value: string | undefined, fallback: number): number {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
}

// `debug` comes from `loadEnv()`: the `.env` file never reaches `process.env`.
function createDiskAssetPlugin(debug: boolean): Plugin {
  return {
    name: 'lumiboot-windows-disk-asset',
    configureServer(server) {
      const middleware = createDiskAssetMiddleware({ debug });
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig(({ mode }) => {
  // Root `.env`: shell variables win; no `node:*` import (no `@types/node`).
  const env = loadEnv(mode, ENV_DIR, '');

  // v64 needs SharedArrayBuffer; LUMIBOOT_COOP_COEP=0 falls back to one thread.
  const crossOriginIsolation = env.LUMIBOOT_COOP_COEP !== '0';

  // Prod sourcemaps: off by default, `1` = served, `hidden` = .map not referenced.
  const sourcemapSetting = env.LUMIBOOT_SOURCEMAP;
  const productionSourcemap: boolean | 'hidden' =
    sourcemapSetting === '1' ? true : sourcemapSetting === 'hidden' ? 'hidden' : false;

  const host = env.WEB_DEV_HOST || '127.0.0.1';
  const port = parsePort(env.WEB_DEV_PORT, DEFAULT_PORT);
  const previewPort = parsePort(env.WEB_PREVIEW_PORT || env.WEB_DEV_PORT, DEFAULT_PORT);

  const isolationHeaders: Record<string, string> | undefined = crossOriginIsolation
    ? {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin',
      }
    : undefined;

  return {
    // The `.env` files live at the repository root, not in `apps/web`.
    envDir: ENV_DIR,
    plugins: [react(), createDiskAssetPlugin(env.LUMIBOOT_DISK_DEBUG === '1')],
    server: {
      host,
      port,
      strictPort: true,
      ...(isolationHeaders ? { headers: isolationHeaders } : {}),
    },
    preview: {
      host,
      port: previewPort,
      strictPort: true,
      ...(isolationHeaders ? { headers: isolationHeaders } : {}),
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: productionSourcemap,
    },
  };
});
