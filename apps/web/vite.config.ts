import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
// Untyped ESM module: serves local RAW disks over HTTP Range (dev).
// @ts-expect-error -- .mjs module without TypeScript types
import { createDiskAssetMiddleware } from '../../scripts/lib/disk-asset-dev.mjs';

// `process` is read through globalThis: no @types/node on the front end.
const nodeEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  ?.env;
// Opt-in COOP/COEP (LUMIBOOT_COOP_COEP=1): not needed for v86 0.5.471, and COEP requires CORP everywhere.
const crossOriginIsolation = nodeEnv?.LUMIBOOT_COOP_COEP === '1';

// Prod sourcemaps: off by default, `1` = served, `hidden` = .map not referenced.
const sourcemapSetting = nodeEnv?.LUMIBOOT_SOURCEMAP;
const productionSourcemap: boolean | 'hidden' =
  sourcemapSetting === '1' ? true : sourcemapSetting === 'hidden' ? 'hidden' : false;
const isolationHeaders: Record<string, string> | undefined = crossOriginIsolation
  ? {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
    }
  : undefined;

// Local disks served in place under images/<ref>/: v86 reads `hda` in ranges, outside the bundle.
const windowsDiskAssetPlugin: Plugin = {
  name: 'lumiboot-windows-disk-asset',
  configureServer(server) {
    const middleware = createDiskAssetMiddleware();
    server.middlewares.use(middleware);
  },
};

export default defineConfig({
  plugins: [react(), windowsDiskAssetPlugin],
  server: {
    port: 5173,
    strictPort: true,
    ...(isolationHeaders ? { headers: isolationHeaders } : {}),
  },
  preview: {
    port: 5173,
    strictPort: true,
    ...(isolationHeaders ? { headers: isolationHeaders } : {}),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: productionSourcemap,
  },
});
