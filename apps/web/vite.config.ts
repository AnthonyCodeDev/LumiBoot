import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
// Module Node ESM (sans déclarations de types) : sert le disque RAW local
// Windows 7 par HTTP Range en développement, sans copie dans `public/`.
// @ts-expect-error -- module .mjs sans types TypeScript
import { createDiskAssetMiddleware } from '../../scripts/lib/disk-asset-dev.mjs';

/**
 * Isolation cross-origin (COOP/COEP) OPTIONNELLE.
 *
 * v86 0.5.471 n'utilise PAS `SharedArrayBuffer` (vérifié dans
 * `build/libv86.js`) : COOP/COEP ne sont donc pas requis aujourd'hui. Certaines
 * versions de v86 — ou de futurs moteurs WASM — peuvent en avoir besoin. On les
 * active à la demande via `LUMIBOOT_COOP_COEP=1`, jamais par défaut : un
 * `Cross-Origin-Embedder-Policy: require-corp` casserait les ressources
 * cross-origin non marquées CORP (par ex. Google Fonts).
 *
 * `process` est lu via `globalThis` pour ne pas exiger `@types/node` dans un
 * fichier de configuration front.
 */
const nodeEnv = (
  globalThis as { process?: { env?: Record<string, string | undefined> } }
).process?.env;
const crossOriginIsolation = nodeEnv?.LUMIBOOT_COOP_COEP === '1';
const isolationHeaders: Record<string, string> | undefined = crossOriginIsolation
  ? {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
    }
  : undefined;

/**
 * Sert `images/windows-7-x86/disk.img` (hors `public/`, ignoré par Git) en
 * HTTP Range sur la même origine que l'app. v86 lit `hda` par plages : sans
 * ce middleware, le disque de 16 Gio ne serait pas accessible en développement
 * et ne doit jamais entrer dans le bundle Vite. En production, aucun disque
 * local n'est servi (voir docs/windows-7.md).
 */
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
    sourcemap: true,
  },
});
