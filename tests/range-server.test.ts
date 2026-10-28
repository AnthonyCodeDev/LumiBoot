import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssetServer, parseRangeHeader } from '../scripts/lib/range-server.mjs';

/**
 * Real tests of the local Range HTTP server, with no network mock: a server
 * starts on an ephemeral port and the exact returned bytes are read. This proves
 * that v86 really gets compliant 206 responses to `Range: bytes=...`.
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
  it('rejects a missing header or unknown unit (whole resource)', () => {
    expect(parseRangeHeader(undefined, SIZE)).toEqual({ kind: 'none' });
    expect(parseRangeHeader('', SIZE)).toEqual({ kind: 'none' });
    expect(parseRangeHeader('items=0-1', SIZE)).toEqual({ kind: 'none' });
  });

  it('normalizes simple, open and suffix ranges', () => {
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

  it('reports an unsatisfiable range', () => {
    expect(parseRangeHeader('bytes=1000-1100', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('ignores a syntactically invalid range (last < first)', () => {
    expect(parseRangeHeader('bytes=5-3', SIZE)).toEqual({ kind: 'none' });
  });

  it('merges adjacent ranges', () => {
    expect(parseRangeHeader('bytes=0-4,5-9', SIZE)).toEqual({
      kind: 'ranges',
      ranges: [{ start: 0, end: 9 }],
    });
  });
});

describe('createAssetServer - real HTTP Range', () => {
  it('serves the whole resource as 200 with Accept-Ranges', async () => {
    const res = await rawRequest(`${DISK_PATH}?token=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-length']).toBe(String(SIZE));
    expect(res.body.equals(pattern)).toBe(true);
  });

  it('answers 206 to the v86 probe `Range: bytes=0-0` with the total Content-Range', async () => {
    const res = await rawRequest(`${DISK_PATH}?token=${TOKEN}`, {
      headers: { Range: 'bytes=0-0', 'X-Accept-Encoding': 'identity' },
    });
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 0-0/${SIZE}`);
    expect(res.headers['content-length']).toBe('1');
    expect(res.body).toEqual(pattern.subarray(0, 1));
    // v86 gives up if the server answers 200 to a Range request.
    expect(res.status).not.toBe(200);
  });

  it('serves a simple range with the exact bytes', async () => {
    const res = await rawRequest(`${DISK_PATH}?token=${TOKEN}`, {
      headers: { Range: 'bytes=10-19' },
    });
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 10-19/${SIZE}`);
    expect(res.headers['content-length']).toBe('10');
    expect(res.body.equals(pattern.subarray(10, 20))).toBe(true);
  });

  it('serves an open range up to the end', async () => {
    const res = await rawRequest(`${DISK_PATH}?token=${TOKEN}`, {
      headers: { Range: 'bytes=990-' },
    });
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 990-999/${SIZE}`);
    expect(res.body.equals(pattern.subarray(990))).toBe(true);
  });

  it('serves a suffix range', async () => {
    const res = await rawRequest(`${DISK_PATH}?token=${TOKEN}`, {
      headers: { Range: 'bytes=-10' },
    });
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 990-999/${SIZE}`);
    expect(res.body.equals(pattern.subarray(990))).toBe(true);
  });

  it('answers 416 with Content-Range */size for an unsatisfiable range', async () => {
    const res = await rawRequest(`${DISK_PATH}?token=${TOKEN}`, {
      headers: { Range: 'bytes=1000-1100' },
    });
    expect(res.status).toBe(416);
    expect(res.headers['content-range']).toBe(`bytes */${SIZE}`);
  });

  it('honors HEAD without a body but with the exact Content-Length', async () => {
    const res = await rawRequest(`${DISK_PATH}?token=${TOKEN}`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBe(String(SIZE));
    expect(res.body.byteLength).toBe(0);
  });

  it('answers CORS OPTIONS preflights (Range + X-Accept-Encoding)', async () => {
    const res = await rawRequest(`${DISK_PATH}?token=${TOKEN}`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(String(res.headers['access-control-allow-headers'])).toContain('Range');
    expect(String(res.headers['access-control-allow-headers'])).toContain('X-Accept-Encoding');
  });

  it('serves a multi-range as multipart/byteranges', async () => {
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
    // The exact bytes of both ranges must be present.
    expect(res.body.includes(pattern.subarray(0, 1))).toBe(true);
    expect(res.body.includes(pattern.subarray(10, 12))).toBe(true);
    expect(res.body.includes(Buffer.from(`--${boundary}--`))).toBe(true);
  });

  it('refuses a request without a token', async () => {
    const res = await rawRequest(DISK_PATH);
    expect(res.status).toBe(401);
  });

  it('accepts the token through a header', async () => {
    const res = await rawRequest(DISK_PATH, { headers: { 'X-Lumiboot-Token': TOKEN } });
    expect(res.status).toBe(200);
  });

  it('refuses an unsupported method', async () => {
    const res = await rawRequest(`${DISK_PATH}?token=${TOKEN}`, { method: 'POST' });
    expect(res.status).toBe(405);
  });

  it('serves the local JSON manifest on the same origin', async () => {
    const res = await rawRequest(`${MANIFEST_PATH}?token=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('application/json');
    expect(JSON.parse(res.body.toString('utf8'))).toMatchObject({
      ref: 'windows-7-x86',
      size: SIZE,
    });
  });
});

describe('createAssetServer - guardrails', () => {
  it('returns 404 for an unknown route', async () => {
    const res = await rawRequest('/unknown');
    expect(res.status).toBe(404);
  });

  it('refuses a token that is too short', () => {
    expect(() =>
      createAssetServer({ token: 'short', routes: { [DISK_PATH]: { file: diskFile } } }),
    ).toThrow();
  });

  it('rejects a route without file or json', () => {
    expect(() => createAssetServer({ token: TOKEN, routes: { '/x': {} } })).toThrow();
  });
});
