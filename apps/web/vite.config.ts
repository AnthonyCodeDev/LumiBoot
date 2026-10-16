import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
// Module Node ESM (sans déclarations de types) : sert les disques RAW locaux
// par HTTP Range en développement, sans copie dans `public/`.
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
const nodeEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  ?.env;
const crossOriginIsolation = nodeEnv?.LUMIBOOT_COOP_COEP === '1';

/**
 * Sourcemaps de production.
 *
 * DÉSACTIVÉES PAR DÉFAUT : une sourcemap publique expose le code source original
 * (`sourcesContent`), ce qui abaisse fortement le coût d'exploitation d'une XSS
 * (lecture des constantes, des chemins, des gardes) et peut divulguer des
 * fragments sensibles. Un déploiement qui en a réellement besoin (suivi
 * d'erreurs interne) doit l'activer EXPLICITEMENT :
 *   - `LUMIBOOT_SOURCEMAP=1`      → sourcemap classique (servie) ;
 *   - `LUMIBOOT_SOURCEMAP=hidden` → `.map` non référencée par le bundle (à ne
 *     PAS publier sur le webroot statique).
 */
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

/**
 * Sert les disques RAW locaux découverts sous `images/<ref>/` (hors `public/`,
 * ignorés par Git) en HTTP Range sur la même origine que l'app. v86 lit `hda`
 * par plages : sans ce middleware, un disque de plusieurs dizaines de Gio ne
 * serait pas accessible en développement et ne doit jamais entrer dans le
 * bundle Vite. La découverte est générique (Windows XP/Vista/7/8/10) : chaque
 * manifeste `boot.mode === 'disk-boot'` est servi in-place. En production,
 * aucun disque local n'est servi (voir docs/windows-7.md).
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
    sourcemap: productionSourcemap,
  },
});
