// Minimal `.env` reader: no dependency, no variable expansion, shell wins.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root, computed from this file (`scripts/lib/load-env.mjs`). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const DOUBLE_QUOTE_ESCAPES = {
  n: '\n',
  r: '\r',
  t: '\t',
  '"': '"',
  '\\': '\\',
};

function unescapeDoubleQuoted(value) {
  return value.replace(/\\([nrt"\\])/g, (_match, char) => DOUBLE_QUOTE_ESCAPES[char] ?? char);
}

function parseValue(raw) {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return unescapeDoubleQuoted(value.slice(1, -1));
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  // Unquoted: a `#` preceded by whitespace starts a trailing comment.
  return value.replace(/\s+#.*$/, '').trim();
}

/** Parses dotenv-style text into a plain object. */
export function parseEnv(text) {
  const env = {};
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!KEY_PATTERN.test(key)) continue;
    env[key] = parseValue(trimmed.slice(separator + 1));
  }
  return env;
}

/** Loads `.env` without overriding existing variables; a missing file is fine. */
export function loadEnvFile(path = '.env', env = process.env) {
  const filePath = isAbsolute(path) ? path : resolve(process.cwd(), path);
  const parsed = existsSync(filePath) ? parseEnv(readFileSync(filePath, 'utf8')) : {};

  const merged = { ...parsed };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) merged[key] = value;
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) env[key] = value;
  }
  return merged;
}
