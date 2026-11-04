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
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  originFor,
  parseArgs,
  toPublicServedManifest,
} from '../scripts/serve-windows7-asset.mjs';

// P1: a served disk manifest never exposes `source` (machine path) nor `provenance`.

/** A foreign HTTPS origin: the development middleware is same-origin only. */
const FOREIGN_ORIGIN = 'https://other.example';
/** A foreign host with an explicit port, as used by a cross-origin page. */
const FOREIGN_HOST = 'other.example:5200';

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

/** v64 manifest with an OVMF NVRAM image served next to the disk. */
function privateV64DiskManifest(ref: string, diskPath: string, firmwareFileName: string) {
  const manifest = privateDiskManifest(ref, diskPath, 100) as Record<string, unknown>;
  manifest.architecture = 'x86_64';
  manifest.engine = { id: 'v64' };
  manifest.firmware = {
    type: 'uefi',
    vars: {
      fileName: firmwareFileName,
      url: `/images/${ref}/${firmwareFileName}`,
      size: 32,
      mtimeMs: 1,
    },
  };
  return manifest;
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
    const req = httpRequest({ host: DEFAULT_HOST, port, path, headers }, (res) => {
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

  it('keeps the UEFI firmware block when the manifest declares one', () => {
    const manifest = privateV64DiskManifest('windows-11-x64', 'C:/secret/disk.img', 'uefi-vars.fd');
    const publicManifest = toPublicDiskManifest(manifest) as Record<string, unknown>;

    expect(publicManifest.firmware).toEqual(manifest.firmware);
    expect(publicManifest.engine).toEqual({ id: 'v64' });
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

  it('requires a token when exposing the asset server beyond loopback', () => {
    expect(() => parseArgs(['--host', '0.0.0.0', '--expose', '--no-token'])).toThrow(
      '--no-token is only allowed with a loopback host',
    );
  });

  it('reads the LUMIBOOT_ASSET_* environment defaults', () => {
    const options = parseArgs([], {
      LUMIBOOT_ASSET_PORT: '4000',
      LUMIBOOT_ASSET_HOST: 'localhost',
      LUMIBOOT_ASSET_MANIFEST: 'images/custom/manifest.json',
    });
    expect(options.port).toBe(4000);
    expect(options.host).toBe('localhost');
    expect(options.manifest).toBe('images/custom/manifest.json');
    expect(options.noToken).toBe(false);
  });

  it('keeps the built-in defaults when the environment is empty', () => {
    const options = parseArgs([], {});
    expect(options.port).toBe(DEFAULT_PORT);
    expect(options.host).toBe(DEFAULT_HOST);
    expect(options.manifest).toMatch(/images[\\/]windows-7-pro-sp1-x86[\\/]manifest\.json$/);
  });

  it('lets a CLI argument win over the environment', () => {
    const options = parseArgs(['--port', '1234'], {
      LUMIBOOT_ASSET_PORT: '4000',
      LUMIBOOT_ASSET_HOST: 'localhost',
    });
    expect(options.port).toBe(1234);
    expect(options.host).toBe('localhost');
  });

  it('rejects LUMIBOOT_ASSET_NO_TOKEN on a non-loopback host', () => {
    expect(() =>
      parseArgs([], { LUMIBOOT_ASSET_NO_TOKEN: '1', LUMIBOOT_ASSET_HOST: '0.0.0.0' }),
    ).toThrow('--no-token is only allowed with a loopback host');
  });

  it('originFor brackets IPv6 literals and maps wildcard hosts to loopback', () => {
    const loopback = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
    expect(originFor(DEFAULT_HOST, DEFAULT_PORT)).toBe(loopback);
    expect(originFor('0.0.0.0', DEFAULT_PORT)).toBe(loopback);
    expect(originFor('::', DEFAULT_PORT)).toBe(loopback);
    expect(originFor('::1', DEFAULT_PORT)).toBe(`http://[::1]:${DEFAULT_PORT}`);
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

    // A v64 disk with its OVMF NVRAM, plus one whose firmware file is missing.
    const v64Ref = 'demo-v64';
    const v64Dir = join(imagesDir, v64Ref);
    mkdirSync(v64Dir, { recursive: true });
    const v64Disk = join(v64Dir, 'disk.img');
    writeFileSync(v64Disk, Buffer.alloc(100, 9));
    writeFileSync(join(v64Dir, 'uefi-vars.fd'), Buffer.alloc(32, 3));
    writeFileSync(
      join(v64Dir, 'manifest.json'),
      `${JSON.stringify(privateV64DiskManifest(v64Ref, v64Disk, 'uefi-vars.fd'), null, 2)}\n`,
      'utf8',
    );

    const orphanRef = 'demo-v64-orphan';
    const orphanDir = join(imagesDir, orphanRef);
    mkdirSync(orphanDir, { recursive: true });
    const orphanDisk = join(orphanDir, 'disk.img');
    writeFileSync(orphanDisk, Buffer.alloc(100, 11));
    writeFileSync(
      join(orphanDir, 'manifest.json'),
      `${JSON.stringify(privateV64DiskManifest(orphanRef, orphanDisk, 'absent.fd'), null, 2)}\n`,
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
    await new Promise<void>((resolve) => server?.listen(0, DEFAULT_HOST, () => resolve()));
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

  it('serves the UEFI vars image over HTTP Range for a v64 disk', async () => {
    const res = await rawRequest(port, '/images/demo-v64/uefi-vars.fd', {
      Range: 'bytes=0-15',
    });
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 0-15/32');
    expect(res.body.byteLength).toBe(16);

    const manifest = JSON.parse(
      (await rawRequest(port, '/images/demo-v64/manifest.json')).body.toString('utf8'),
    ) as { engine: { id: string }; firmware?: { type: string; vars: { url: string } } };
    expect(manifest.engine).toEqual({ id: 'v64' });
    expect(manifest.firmware?.type).toBe('uefi');
    expect(manifest.firmware?.vars.url).toBe('/images/demo-v64/uefi-vars.fd');
  });

  it('still serves the disk when the firmware image is missing', async () => {
    const manifest = JSON.parse(
      (await rawRequest(port, '/images/demo-v64-orphan/manifest.json')).body.toString('utf8'),
    ) as Record<string, unknown>;
    // A missing NVRAM must not be advertised, and must not hide the disk.
    expect(manifest).not.toHaveProperty('firmware');

    const disk = await rawRequest(port, '/images/demo-v64-orphan/disk.img', {
      Range: 'bytes=0-0',
    });
    expect(disk.status).toBe(206);
    expect(disk.headers['content-range']).toBe('bytes 0-0/100');
  });

  it('restricts local disk access to the development origin', async () => {
    const path = '/images/demo-disk/manifest.json';
    const sameOrigin = await rawRequest(port, path, { Origin: `http://127.0.0.1:${port}` });
    expect(sameOrigin.status).toBe(200);
    expect(sameOrigin.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(sameOrigin.headers['access-control-allow-origin']).toBeUndefined();

    const foreignOrigin = await rawRequest(port, path, { Origin: FOREIGN_ORIGIN });
    expect(foreignOrigin.status).toBe(403);
    expect(foreignOrigin.headers['access-control-allow-origin']).toBeUndefined();
    expect(foreignOrigin.body.byteLength).toBe(0);

    const reboundHost = await rawRequest(port, path, {
      Host: FOREIGN_HOST,
      Origin: `http://${FOREIGN_HOST}`,
    });
    expect(reboundHost.status).toBe(403);
  });
});
