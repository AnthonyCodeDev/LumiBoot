// Serveur HTTP local servant un fichier par requêtes Range (RFC 9110 §14),
// utilisé pour streamer un disque dur volumineux vers v86 sans jamais le
// charger entièrement en mémoire ni le copier dans public/.
//
// Exigences v86 0.5.471 (vérifiées dans build/libv86.js) :
//   - v86 charge les images `hda.async` par XMLHttpRequest avec
//     `Range: bytes=<start>-<end>` et `X-Accept-Encoding: identity` ;
//   - si un serveur répond 200 à une requête Range, v86 JOURNALISE et ABANDONNE
//     (« Server sent full file in response to ranged request, aborting ») :
//     il FAUT donc répondre 206 pour toute requête Range valide ;
//   - v86 sonde la taille via `Range: bytes=0-0` et lit la taille totale dans
//     l'en-tête `Content-Range` (regex /\/(\d+)\s*$/) : `Content-Range` doit
//     toujours être présent, y compris pour les petites plages ;
//   - aucune compression ne doit être appliquée (une réponse encodée casse le
//     décodage des plages) ; on ne définit donc jamais Content-Encoding.

import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const CRLF = '\r\n';

/**
 * Analyse un en-tête `Range` (RFC 9110).
 *
 * @param {string | undefined | null} headerValue
 * @param {number} size taille totale en octets
 * @returns {{kind: 'none'} | {kind: 'unsatisfiable'} | {kind: 'ranges', ranges: Array<{start: number, end: number}>}}
 *   `none` = pas d'en-tête OU en-tête invalide/illisible (à ignorer, servir la
 *   ressource entière) ; `unsatisfiable` = syntaxe valide mais aucune plage ne
 *   chevauche la ressource (416) ; `ranges` = plages satisfaisables triées.
 */
export function parseRangeHeader(headerValue, size) {
  if (headerValue === undefined || headerValue === null || headerValue === '') {
    return { kind: 'none' };
  }
  if (!Number.isInteger(size) || size < 0) {
    throw new TypeError('La taille doit être un entier >= 0.');
  }

  const value = String(headerValue).trim();
  const equals = value.indexOf('=');
  if (equals === -1) return { kind: 'none' };
  const unit = value.slice(0, equals).trim().toLowerCase();
  if (unit !== 'bytes') return { kind: 'none' };

  const spec = value.slice(equals + 1);
  if (spec.trim() === '') return { kind: 'none' };

  const specs = spec.split(',');
  const ranges = [];

  for (const rawSpec of specs) {
    const part = rawSpec.trim();
    if (part === '') return { kind: 'none' };
    const dash = part.indexOf('-');
    if (dash === -1) return { kind: 'none' };
    const firstText = part.slice(0, dash).trim();
    const lastText = part.slice(dash + 1).trim();

    if (firstText === '' && lastText === '') return { kind: 'none' };

    if (firstText === '') {
      // Plage suffixe : `-N` = N derniers octets.
      if (!/^\d+$/.test(lastText)) return { kind: 'none' };
      const suffix = Number(lastText);
      if (suffix <= 0 || size === 0) continue; // non satisfaisable
      ranges.push({ start: Math.max(size - suffix, 0), end: size - 1 });
      continue;
    }

    if (!/^\d+$/.test(firstText)) return { kind: 'none' };
    const first = Number(firstText);

    if (lastText === '') {
      if (first >= size) continue; // non satisfaisable
      ranges.push({ start: first, end: size - 1 });
      continue;
    }

    if (!/^\d+$/.test(lastText)) return { kind: 'none' };
    let last = Number(lastText);
    // `last < first` rend l'en-tête entier invalide (RFC) : on l'ignore.
    if (last < first) return { kind: 'none' };
    if (last >= size) last = size - 1;
    if (first >= size) continue;
    ranges.push({ start: first, end: last });
  }

  if (ranges.length === 0) return { kind: 'unsatisfiable' };

  // Fusionne les plages adjacentes/chevauchantes pour éviter des multiparts
  // inutiles tout en conservant l'ordre demandé.
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && range.start <= previous.end + 1) {
      if (range.end > previous.end) previous.end = range.end;
    } else {
      merged.push({ ...range });
    }
  }

  return { kind: 'ranges', ranges: merged };
}

function tokenMatches(candidate, expected) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Vérifie le jeton d'accès (`?token=` ou en-tête `x-lumiboot-token`). */
export function isAuthorized(req, token) {
  if (token === null) return true;
  const headerToken = req.headers['x-lumiboot-token'];
  if (Array.isArray(headerToken)) {
    if (headerToken.some((value) => tokenMatches(value, token))) return true;
  } else if (tokenMatches(headerToken, token)) {
    return true;
  }
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const queryToken = url.searchParams.get('token');
    if (queryToken !== null && tokenMatches(queryToken, token)) return true;
  } catch {
    /* URL illisible : non autorisé */
  }
  return false;
}

function baseHeaders(corsOrigin, extraHeaders) {
  return {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(corsOrigin
      ? {
          'Access-Control-Allow-Origin': corsOrigin,
          'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
        }
      : {}),
    ...extraHeaders,
  };
}

function writeHeaders(res, status, headers) {
  res.statusCode = status;
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
}

function multipartLength(boundary, ranges, size, contentType) {
  let total = 0;
  for (const range of ranges) {
    total += Buffer.byteLength(`--${boundary}${CRLF}`);
    total += Buffer.byteLength(`Content-Type: ${contentType}${CRLF}`);
    total += Buffer.byteLength(`Content-Range: bytes ${range.start}-${range.end}/${size}${CRLF}`);
    total += Buffer.byteLength(CRLF);
    total += range.end - range.start + 1;
    total += Buffer.byteLength(CRLF);
  }
  total += Buffer.byteLength(`--${boundary}--${CRLF}`);
  return total;
}

/**
 * Crée un handler Node `(req, res)` servant UN fichier fixe par plages.
 * Le chemin n'est jamais dérivé de la requête : aucune traversée de répertoire.
 */
export function createRangeHandler(options) {
  const {
    filePath,
    size,
    contentType = 'application/octet-stream',
    corsOrigin = '*',
    extraHeaders = {},
    token = null,
    maxRanges = 32,
  } = options;
  if (!Number.isInteger(size) || size < 0) {
    throw new TypeError('« size » doit être un entier >= 0.');
  }

  return function handleRangeRequest(req, res) {
    const headers = baseHeaders(corsOrigin, extraHeaders);

    if (!isAuthorized(req, token)) {
      writeHeaders(res, 401, {
        ...headers,
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': '0',
        'WWW-Authenticate': 'Bearer realm="lumiboot-local-asset"',
      });
      res.end();
      return;
    }

    if (req.method === 'OPTIONS') {
      writeHeaders(res, 204, {
        ...headers,
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, X-Accept-Encoding, X-Lumiboot-Token, Content-Type',
        'Access-Control-Max-Age': '600',
        'Content-Length': '0',
      });
      res.end();
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      writeHeaders(res, 405, {
        ...headers,
        Allow: 'GET, HEAD, OPTIONS',
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': '0',
      });
      res.end();
      return;
    }

    const state = createResponseState(res);
    const parsed = parseRangeHeader(req.headers.range, size);

    if (parsed.kind === 'unsatisfiable') {
      writeHeaders(res, 416, {
        ...headers,
        'Content-Range': `bytes */${size}`,
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': '0',
      });
      res.end();
      return;
    }

    if (parsed.kind === 'none' || parsed.ranges.length > maxRanges) {
      sendFull(req, res, state, { headers, filePath, size, contentType });
      return;
    }

    if (parsed.ranges.length === 1) {
      sendSingleRange(req, res, state, parsed.ranges[0], {
        headers,
        filePath,
        size,
        contentType,
      });
      return;
    }

    sendMultipartRanges(req, res, state, parsed.ranges, {
      headers,
      filePath,
      size,
      contentType,
    });
  };
}

function createResponseState(res) {
  const streams = new Set();
  let aborted = false;
  res.on('close', () => {
    aborted = true;
    for (const stream of streams) stream.destroy();
    streams.clear();
  });
  return {
    aborted: () => aborted,
    track(stream) {
      streams.add(stream);
      stream.once('close', () => streams.delete(stream));
    },
  };
}

function sendFull(req, res, state, { headers, filePath, size, contentType }) {
  writeHeaders(res, 200, {
    ...headers,
    'Content-Type': contentType,
    'Content-Length': String(size),
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(filePath);
  state.track(stream);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

function sendSingleRange(req, res, state, range, { headers, filePath, size, contentType }) {
  const length = range.end - range.start + 1;
  writeHeaders(res, 206, {
    ...headers,
    'Content-Type': contentType,
    'Content-Length': String(length),
    'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(filePath, { start: range.start, end: range.end });
  state.track(stream);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

function sendMultipartRanges(req, res, state, ranges, { headers, filePath, size, contentType }) {
  const boundary = `lumiboot-${randomBytes(12).toString('hex')}`;
  const total = multipartLength(boundary, ranges, size, contentType);
  writeHeaders(res, 206, {
    ...headers,
    'Content-Type': `multipart/byteranges; boundary=${boundary}`,
    'Content-Length': String(total),
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  void writeMultipart(res, state, { filePath, ranges, size, contentType, boundary });
}

async function writeMultipart(res, state, { filePath, ranges, size, contentType, boundary }) {
  try {
    for (const range of ranges) {
      if (state.aborted()) return;
      res.write(`--${boundary}${CRLF}`);
      res.write(`Content-Type: ${contentType}${CRLF}`);
      res.write(`Content-Range: bytes ${range.start}-${range.end}/${size}${CRLF}${CRLF}`);
      await pipeRange(res, state, filePath, range);
      if (state.aborted()) return;
      res.write(CRLF);
    }
    if (state.aborted()) return;
    res.end(`--${boundary}--${CRLF}`);
  } catch {
    if (!state.aborted()) res.destroy();
  }
}

function pipeRange(res, state, filePath, range) {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, { start: range.start, end: range.end });
    state.track(stream);
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      stream.destroy();
      if (error) reject(error);
      else resolve();
    };
    stream.on('data', (chunk) => {
      if (state.aborted()) {
        settle();
        return;
      }
      if (!res.write(chunk)) {
        stream.pause();
        res.once('drain', () => stream.resume());
      }
    });
    stream.on('end', () => settle());
    stream.on('error', (error) => settle(error));
    stream.on('close', () => settle());
  });
}

/** Handler JSON sans support Range (petits manifestes uniquement). */
export function createJsonHandler(options) {
  const {
    body,
    contentType = 'application/json; charset=utf-8',
    corsOrigin = '*',
    extraHeaders = {},
    token = null,
  } = options;
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');

  return function handleJsonRequest(req, res) {
    const headers = baseHeaders(corsOrigin, extraHeaders);
    if (!isAuthorized(req, token)) {
      writeHeaders(res, 401, { ...headers, 'Content-Length': '0' });
      res.end();
      return;
    }
    if (req.method === 'OPTIONS') {
      writeHeaders(res, 204, {
        ...headers,
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'X-Lumiboot-Token, Content-Type',
        'Access-Control-Max-Age': '600',
        'Content-Length': '0',
      });
      res.end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      writeHeaders(res, 405, { ...headers, Allow: 'GET, HEAD, OPTIONS', 'Content-Length': '0' });
      res.end();
      return;
    }
    writeHeaders(res, 200, {
      ...headers,
      'Content-Type': contentType,
      'Content-Length': String(buffer.byteLength),
    });
    res.end(req.method === 'HEAD' ? undefined : buffer);
  };
}

function resolveRoute(route) {
  if (route.file !== undefined) {
    const info = statSync(route.file);
    if (!info.isFile()) throw new Error(`« ${route.file} » n'est pas un fichier.`);
    return {
      kind: 'file',
      filePath: route.file,
      size: info.size,
      contentType: route.contentType ?? 'application/octet-stream',
    };
  }
  if (route.json !== undefined) {
    const text =
      typeof route.json === 'string' ? route.json : `${JSON.stringify(route.json, null, 2)}\n`;
    return { kind: 'json', body: Buffer.from(text, 'utf8') };
  }
  throw new Error('Route invalide : fournir « file » ou « json ».');
}

/**
 * Crée un serveur HTTP servant plusieurs routes fixes (fichiers par Range +
 * manifestes JSON). Par défaut le serveur n'est PAS écouté : l'appelant choisit
 * l'interface (recommandé : loopback) via `listen()`.
 *
 * @param {{
 *   routes: Record<string, {file?: string, json?: unknown, contentType?: string}>,
 *   token?: string | null,
 *   corsOrigin?: string,
 *   extraHeaders?: Record<string, string>,
 * }} options
 */
export function createAssetServer(options) {
  const {
    routes,
    token = null,
    corsOrigin = '*',
    extraHeaders = {},
  } = options;
  if (token !== null && token.length < 8) {
    throw new Error('Le jeton doit faire au moins 8 caractères.');
  }

  const handlers = new Map();
  for (const [pathname, rawRoute] of Object.entries(routes)) {
    const route = resolveRoute(rawRoute);
    if (route.kind === 'file') {
      handlers.set(
        pathname,
        createRangeHandler({
          filePath: route.filePath,
          size: route.size,
          contentType: route.contentType,
          corsOrigin,
          extraHeaders,
          token,
        }),
      );
    } else {
      handlers.set(
        pathname,
        createJsonHandler({ body: route.body, corsOrigin, extraHeaders, token }),
      );
    }
  }

  const server = createServer((req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      pathname = '/';
    }
    const handler = handlers.get(pathname);
    if (handler === undefined) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Not found');
      return;
    }
    handler(req, res);
  });

  return {
    server,
    routes: [...handlers.keys()],
    /** Écoute et résout l'adresse réellement liée. */
    listen({ host = '127.0.0.1', port = 0 } = {}) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server.address()));
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
