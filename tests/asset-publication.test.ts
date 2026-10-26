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
import { createDiskAssetMiddleware, toPublicDiskManifest } from '../scripts/lib/disk-asset-dev.mjs';
import { parseArgs, toPublicServedManifest } from '../scripts/serve-windows7-asset.mjs';

/**
 * P1: a disk manifest served over HTTP must NEVER expose `source` (the real
 * machine path) nor `provenance` (internal). These tests cover the public
 * serialization of both local servers and check, against a real HTTP server,
 * that no source path leaks out of the development middleware.
 */

function privateDiskManifest(ref: string, diskPath: string, size: number) {
  return {
    version: 1,
    ref,
    displayName: `${ref} (local media)`,
    architecture: 'i386',
    memoryMiB: 1024,
    vgaMemoryMiB: 16,
    license: 'User license',
    provenance: `local disk ${diskPath}`,
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

describe('toPublicDiskManifest (dev middleware)', () => {
  it('strips source and provenance, keeps the public fields', () => {
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
  it('strips the internal fields and appends the token to every URL', () => {
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

  it('parseArgs stays importable without running the server (static help)', () => {
    const options = parseArgs(['--port', '1234', '--no-token']);
    expect(options.port).toBe(1234);
    expect(options.noToken).toBe(true);
  });
});

describe('createDiskAssetMiddleware - public manifest over real HTTP', () => {
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
        res.end('not found');
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

  it('serves the manifest WITHOUT source or provenance and without an absolute path', async () => {
    const res = await rawRequest(port, '/images/demo-disk/manifest.json');
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('application/json');
    const body = res.body.toString('utf8');
    const manifest = JSON.parse(body) as Record<string, unknown>;
    expect(manifest.ref).toBe('demo-disk');
    expect(manifest).not.toHaveProperty('source');
    expect(manifest).not.toHaveProperty('provenance');
    // The real machine path must not appear anywhere.
    expect(body).not.toContain(diskPath);
    expect(body.toLowerCase()).not.toContain('provenance');
  });

  it('serves the disk over HTTP Range (206)', async () => {
    const res = await rawRequest(port, '/images/demo-disk/disk.img', {
      Range: 'bytes=0-0',
    });
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 0-0/100');
  });
});
