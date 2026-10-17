import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssetServer, parseRangeHeader } from '../scripts/lib/range-server.mjs';

/**
 * Tests réels du serveur HTTP Range local (aucun mock réseau) : on démarre un
 * serveur sur un port éphémère et on lit les octets exacts renvoyés. C'est la
 * preuve que v86 (`Range: bytes=...`) obtient bien des réponses 206 conformes.
 */

const SIZE = 1000;
const DISK_PATH = '/images/windows-7-x86/disk.img';
const MANIFEST_PATH = '/images/windows-7-x86/manifest.json';
const TOKEN = 'test-token-123456';

let assetServer: ReturnType<typeof createAssetServer>;
let port = 0;
let tempDir = '';
let diskFile = '';
let pattern: Buffer;

interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

function rawRequest(
  path: string,
  { method = 'GET', headers = {} }: { method?: string; headers?: Record<string, string> } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
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

beforeAll(async () => {
  pattern = Buffer.alloc(SIZE);
  for (let i = 0; i < SIZE; i += 1) pattern[i] = i % 256;

  tempDir = mkdtempSync(join(tmpdir(), 'lumiboot-range-'));
  diskFile = join(tempDir, 'disk.img');
  writeFileSync(diskFile, pattern);

  assetServer = createAssetServer({
    token: TOKEN,
    routes: {
      [DISK_PATH]: { file: diskFile, contentType: 'application/octet-stream' },
      [MANIFEST_PATH]: {
        json: { version: 1, ref: 'windows-7-x86', size: SIZE },
        contentType: 'application/json; charset=utf-8',
      },
    },
  });
  const address = await assetServer.listen({ host: '127.0.0.1', port: 0 });
  port = typeof address === 'object' && address !== null ? address.port : 0;
});

afterAll(async () => {
  await assetServer.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('parseRangeHeader', () => {
  it('rejette un en-tête absent ou d’unité inconnue (ressource entière)', () => {
    expect(parseRangeHeader(undefined, SIZE)).toEqual({ kind: 'none' });
    expect(parseRangeHeader('', SIZE)).toEqual({ kind: 'none' });
    expect(parseRangeHeader('items=0-1', SIZE)).toEqual({ kind: 'none' });
  });

  it('normalise les plages simple, ouverte et suffixe', () => {
    expect(parseRangeHeader('bytes=10-19', SIZE)).toEqual({
      kind: 'ranges',
      ranges: [{ start: 10, end: 19 }],
    });
    expect(parseRangeHeader('bytes=990-', SIZE)).toEqual({
      kind: 'ranges',
      ranges: [{ start: 990, end: 999 }],
    });
    expect(parseRangeHeader('bytes=-10', SIZE)).toEqual({
      kind: 'ranges',
      ranges: [{ start: 990, end: 999 }],
    });
  });

  it('signale une plage non satisfaisable', () => {
    expect(parseRangeHeader('bytes=1000-1100', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('ignore une plage syntaxiquement invalide (last < first)', () => {
    expect(parseRangeHeader('bytes=5-3', SIZE)).toEqual({ kind: 'none' });
  });

  it('fusionne les plages adjacentes', () => {
    expect(parseRangeHeader('bytes=0-4,5-9', SIZE)).toEqual({
      kind: 'ranges',
      ranges: [{ start: 0, end: 9 }],
    });
  });
});

describe('createAssetServer — HTTP Range réel', () => {
  it('sert la ressource entière en 200 avec Accept-Ranges', async () => {
    const res = await rawRequest(`${DISK_PATH}?token=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-length']).toBe(String(SIZE));
    expect(res.body.equals(pattern)).toBe(true);
  });

  it('répond 206 à la sonde v86 `Range: bytes=0-0` avec Content-Range total', async () => {
    const res = await rawRequest(`${DISK_PATH}?token=${TOKEN}`, {
      headers: { Range: 'bytes=0-0', 'X-Accept-Encoding': 'identity' },
    });
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 0-0/${SIZE}`);
    expect(res.headers['content-length']).toBe('1');
    expect(res.body).toEqual(pattern.subarray(0, 1));
    // v86 abandonne si le serveur renvoie 200 à une requête Range.
    expect(res.status).not.toBe(200);
  });

  it('sert une plage simple avec des octets exacts', async () => {
    const res = await rawRequest(`${DISK_PATH}?token=${TOKEN}`, {
      headers: { Range: 'bytes=10-19' },
    });
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 10-19/${SIZE}`);
    expect(res.headers['content-length']).toBe('10');
    expect(res.body.equals(pattern.subarray(10, 20))).toBe(true);
  });

  it('sert une plage ouverte jusqu’à la fin', async () => {
    const res = await rawRequest(`${DISK_PATH}?token=${TOKEN}`, {
      headers: { Range: 'bytes=990-' },
    });
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 990-999/${SIZE}`);
    expect(res.body.equals(pattern.subarray(990))).toBe(true);
  });

  it('sert une plage suffixe', async () => {
    const res = await rawRequest(`${DISK_PATH}?token=${TOKEN}`, {
      headers: { Range: 'bytes=-10' },
    });
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 990-999/${SIZE}`);
    expect(res.body.equals(pattern.subarray(990))).toBe(true);
  });

  it('répond 416 avec Content-Range */taille pour une plage non satisfaisable', async () => {
    const res = await rawRequest(`${DISK_PATH}?token=${TOKEN}`, {
      headers: { Range: 'bytes=1000-1100' },
    });
    expect(res.status).toBe(416);
    expect(res.headers['content-range']).toBe(`bytes */${SIZE}`);
  });

  it('honore HEAD sans corps mais avec Content-Length exact', async () => {
    const res = await rawRequest(`${DISK_PATH}?token=${TOKEN}`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBe(String(SIZE));
    expect(res.body.byteLength).toBe(0);
  });

  it('répond aux préflights CORS OPTIONS (Range + X-Accept-Encoding)', async () => {
    const res = await rawRequest(`${DISK_PATH}?token=${TOKEN}`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(String(res.headers['access-control-allow-headers'])).toContain('Range');
    expect(String(res.headers['access-control-allow-headers'])).toContain('X-Accept-Encoding');
  });

  it('sert un multi-range en multipart/byteranges', async () => {
    const res = await rawRequest(`${DISK_PATH}?token=${TOKEN}`, {
      headers: { Range: 'bytes=0-0,10-11' },
    });
    expect(res.status).toBe(206);
    expect(String(res.headers['content-type'])).toMatch(/^multipart\/byteranges; boundary=/);
    const boundary = String(res.headers['content-type']).split('boundary=')[1]!;
    const text = res.body.toString('latin1');
    expect(text).toContain(`--${boundary}`);
    expect(text).toContain(`Content-Range: bytes 0-0/${SIZE}`);
    expect(text).toContain(`Content-Range: bytes 10-11/${SIZE}`);
    // Les octets exacts des deux plages doivent être présents.
    expect(res.body.includes(pattern.subarray(0, 1))).toBe(true);
    expect(res.body.includes(pattern.subarray(10, 12))).toBe(true);
    expect(res.body.includes(Buffer.from(`--${boundary}--`))).toBe(true);
  });

  it('refuse une requête sans jeton', async () => {
    const res = await rawRequest(DISK_PATH);
    expect(res.status).toBe(401);
  });

  it('accepte le jeton par en-tête', async () => {
    const res = await rawRequest(DISK_PATH, { headers: { 'X-Lumiboot-Token': TOKEN } });
    expect(res.status).toBe(200);
  });

  it('refuse une méthode non supportée', async () => {
    const res = await rawRequest(`${DISK_PATH}?token=${TOKEN}`, { method: 'POST' });
    expect(res.status).toBe(405);
  });

  it('sert le manifeste JSON local sur la même origine', async () => {
    const res = await rawRequest(`${MANIFEST_PATH}?token=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('application/json');
    expect(JSON.parse(res.body.toString('utf8'))).toMatchObject({
      ref: 'windows-7-x86',
      size: SIZE,
    });
  });
});

describe('createAssetServer — garde-fous', () => {
  it('retourne 404 pour une route inconnue', async () => {
    const res = await rawRequest('/inconnu');
    expect(res.status).toBe(404);
  });

  it('refuse un jeton trop court', () => {
    expect(() =>
      createAssetServer({ token: 'court', routes: { [DISK_PATH]: { file: diskFile } } }),
    ).toThrow();
  });

  it('rejette une route sans file ni json', () => {
    expect(() => createAssetServer({ token: TOKEN, routes: { '/x': {} } })).toThrow();
  });
});
