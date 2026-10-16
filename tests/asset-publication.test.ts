import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDiskAssetMiddleware,
  toPublicDiskManifest,
} from '../scripts/lib/disk-asset-dev.mjs';
import { parseArgs, toPublicServedManifest } from '../scripts/serve-windows7-asset.mjs';

/**
 * P1 : un manifeste disque diffusé par HTTP ne doit JAMAIS exposer `source`
 * (chemin réel de la machine) ni `provenance` (interne). Ces tests couvrent la
 * sérialisation publique des deux serveurs locaux et vérifient, sur un vrai
 * serveur HTTP, qu'aucun chemin source ne sort du middleware de développement.
 */

function privateDiskManifest(ref: string, diskPath: string, size: number) {
  return {
    version: 1,
    ref,
    displayName: `${ref} (média local)`,
    architecture: 'i386',
    memoryMiB: 1024,
    vgaMemoryMiB: 16,
    license: 'Licence utilisateur',
    provenance: `disque local ${diskPath}`,
    source: { path: diskPath, size, mtimeMs: 1 },
    disk: {
      fileName: 'disk.img',
      format: 'raw',
      url: `/images/${ref}/disk.img`,
      size,
      mtimeMs: 1,
      sha256: 'a'.repeat(64),
    },
    engine: {
      id: 'v86',
      wasm: { url: '/v86/v86.wasm', size: 1, sha256: 'b'.repeat(64) },
      bios: {
        seabios: { url: '/v86/seabios.bin', size: 1, sha256: 'c'.repeat(64) },
        vgabios: { url: '/v86/vgabios.bin', size: 1, sha256: 'd'.repeat(64) },
      },
    },
    boot: {
      mode: 'disk-boot',
      url: `/images/${ref}/disk.img`,
      async: true,
      size,
    },
  };
}

interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

function rawRequest(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

describe('toPublicDiskManifest (middleware de dev)', () => {
  it('retire source et provenance, conserve les champs publics', () => {
    const manifest = privateDiskManifest('windows-7-x86', 'C:/secret/disk.img', 100);
    const publicManifest = toPublicDiskManifest(manifest) as Record<string, unknown>;

    expect(publicManifest).not.toHaveProperty('source');
    expect(publicManifest).not.toHaveProperty('provenance');
    expect(publicManifest.ref).toBe('windows-7-x86');
    expect(publicManifest.disk).toEqual(manifest.disk);
    expect(publicManifest.boot).toEqual(manifest.boot);
    expect(JSON.stringify(publicManifest)).not.toContain('C:/secret/disk.img');
  });
});

describe('toPublicServedManifest (serve-windows7-asset)', () => {
  it('retire les champs internes et greffe le jeton sur toutes les URL', () => {
    const manifest = privateDiskManifest('windows-7-x86', 'C:/secret/disk.img', 100);
    const served = toPublicServedManifest(manifest, { suffix: '?token=abc' }) as {
      disk: { url: string };
      boot: { url: string };
      engine: { wasm: { url: string } };
    };

    expect(served).not.toHaveProperty('source');
    expect(served).not.toHaveProperty('provenance');
    expect(served.disk.url).toBe('/images/windows-7-x86/disk.img?token=abc');
    expect(served.boot.url).toBe('/images/windows-7-x86/disk.img?token=abc');
    expect(served.engine.wasm.url).toBe('/v86/v86.wasm?token=abc');
    expect(JSON.stringify(served)).not.toContain('C:/secret/disk.img');
  });

  it('parseArgs reste importable sans exécuter le serveur (aide statique)', () => {
    const options = parseArgs(['--port', '1234', '--no-token']);
    expect(options.port).toBe(1234);
    expect(options.noToken).toBe(true);
  });
});

describe('createDiskAssetMiddleware — manifeste public sur HTTP réel', () => {
  let tempDir = '';
  let server: Server | null = null;
  let port = 0;
  let diskPath = '';

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'lumiboot-disk-pub-'));
    const imagesDir = join(tempDir, 'images');
    const ref = 'demo-disk';
    const dir = join(imagesDir, ref);
    diskPath = join(dir, 'disk.img');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(diskPath, Buffer.alloc(100, 7));
    writeFileSync(
      join(dir, 'manifest.json'),
      `${JSON.stringify(privateDiskManifest(ref, diskPath, 100), null, 2)}\n`,
      'utf8',
    );

    const middleware = createDiskAssetMiddleware({
      repoRoot: tempDir,
      imagesDir,
      logger: () => undefined,
    }) as (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
    server = createServer((req, res) => {
      middleware(req, res, () => {
        res.statusCode = 404;
        res.end('pas trouvé');
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    port = typeof address === 'object' && address !== null ? address.port : 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      if (server === null) return resolve();
      server.close(() => resolve());
    });
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('sert le manifeste SANS source ni provenance et sans chemin absolu', async () => {
    const res = await rawRequest(port, '/images/demo-disk/manifest.json');
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('application/json');
    const body = res.body.toString('utf8');
    const manifest = JSON.parse(body) as Record<string, unknown>;
    expect(manifest.ref).toBe('demo-disk');
    expect(manifest).not.toHaveProperty('source');
    expect(manifest).not.toHaveProperty('provenance');
    // Le chemin réel de la machine ne doit apparaître nulle part.
    expect(body).not.toContain(diskPath);
    expect(body.toLowerCase()).not.toContain('provenance');
  });

  it('sert le disque en HTTP Range (206)', async () => {
    const res = await rawRequest(port, '/images/demo-disk/disk.img', {
      Range: 'bytes=0-0',
    });
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 0-0/100');
  });
});
