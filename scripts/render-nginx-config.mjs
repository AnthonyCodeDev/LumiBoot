#!/usr/bin/env node
// Renders infra/nginx/*.conf from the templates; --check detects drift.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, loadEnvFile } from './lib/load-env.mjs';

const NGINX_DIR = join(REPO_ROOT, 'infra', 'nginx');

const SITE_TEMPLATE = join(NGINX_DIR, 'site.conf.template');
const HEADERS_TEMPLATE = join(NGINX_DIR, 'security-headers.conf.template');
const SITE_OUTPUT = join(NGINX_DIR, 'site.conf');
const HEADERS_OUTPUT = join(NGINX_DIR, 'security-headers.conf');

/** Defaults: an empty environment renders the historical configuration. */
export const DEFAULTS = Object.freeze({
  domain: 'lumiboot.example.com',
  httpPort: 80,
  proxyPort: 37892,
});

/** `connect-src` order: every host, every scheme, then the `wss:` catch-all. */
const PROXY_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];
const PROXY_SCHEMES = ['http', 'ws', 'https', 'wss'];

const DOMAIN_PATTERN = /^[A-Za-z0-9.*_-]+$/;
const PORT_PATTERN = /^[0-9]+$/;

/** Validates a TCP port: throws instead of clamping. */
function parsePort(value, name) {
  const raw = value === undefined ? '' : String(value).trim();
  if (!PORT_PATTERN.test(raw)) {
    throw new Error(`${name} must be an integer port (1-65535), got ${JSON.stringify(value)}`);
  }
  const port = Number(raw);
  if (port < 1 || port > 65535) {
    throw new Error(`${name} must be within 1-65535, got ${raw}`);
  }
  return port;
}

/** Validates a bare nginx `server_name` (no scheme, no path, nothing injectable). */
function parseDomain(value, name) {
  const raw = value === undefined ? '' : String(value).trim();
  if (raw.length === 0) {
    throw new Error(`${name} must not be empty`);
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) {
    throw new Error(`${name} must be a bare host, without a scheme, got ${JSON.stringify(value)}`);
  }
  if (/[\s/]/.test(raw)) {
    throw new Error(
      `${name} must be a bare host, without spaces or a path, got ${JSON.stringify(value)}`,
    );
  }
  if (!DOMAIN_PATTERN.test(raw)) {
    throw new Error(
      `${name} contains characters that are not valid in a host name, got ${JSON.stringify(value)}`,
    );
  }
  return raw;
}

/** `connect-src` proxy origins for a port, then the `wss:` catch-all. */
export function proxyConnectSrc(port) {
  const origins = PROXY_HOSTS.flatMap((host) =>
    PROXY_SCHEMES.map((scheme) => `${scheme}://${host}:${port}`),
  );
  return [...origins, 'wss:'].join(' ');
}

/** Substitutes `${NAME}` placeholders; an unknown one is an error. */
function fillTemplate(template, values, file) {
  return template.replace(/\$\{([A-Z0-9_]+)\}/g, (match, key) => {
    if (!Object.hasOwn(values, key)) {
      throw new Error(`Unknown placeholder ${match} in ${relative(REPO_ROOT, file)}`);
    }
    return values[key];
  });
}

/** Reads one setting; an absent or blank value falls back to the default. */
function readSetting(env, key, fallback) {
  const value = env[key];
  const trimmed = value === undefined ? '' : String(value).trim();
  return trimmed.length === 0 ? fallback : trimmed;
}

/** Renders both nginx files in memory from the templates, never from `.env`. */
export function renderNginxConfigs(env = {}) {
  const domain = parseDomain(
    readSetting(env, 'LUMIBOOT_DOMAIN', DEFAULTS.domain),
    'LUMIBOOT_DOMAIN',
  );
  const httpPort = parsePort(
    readSetting(env, 'LUMIBOOT_HTTP_PORT', String(DEFAULTS.httpPort)),
    'LUMIBOOT_HTTP_PORT',
  );
  const proxyPort = parsePort(
    readSetting(env, 'LUMIBOOT_PROXY_PORT', String(DEFAULTS.proxyPort)),
    'LUMIBOOT_PROXY_PORT',
  );

  const siteConf = fillTemplate(
    readFileSync(SITE_TEMPLATE, 'utf8'),
    {
      LUMIBOOT_HTTP_PORT: String(httpPort),
      LUMIBOOT_DOMAIN: domain,
    },
    SITE_TEMPLATE,
  );

  const securityHeaders = fillTemplate(
    readFileSync(HEADERS_TEMPLATE, 'utf8'),
    { LUMIBOOT_PROXY_CONNECT_SRC: proxyConnectSrc(proxyPort) },
    HEADERS_TEMPLATE,
  );

  return { siteConf, securityHeaders };
}

/** Compares ignoring line endings: `.gitattributes` pins LF, editors may not. */
function normalize(text) {
  return text.replace(/\r\n/g, '\n');
}

/** Writes both rendered files, or with `check` verifies the tracked ones. */
export function main({ check = false } = {}) {
  const env = loadEnvFile();
  const rendered = renderNginxConfigs(env);

  const files = [
    { path: SITE_OUTPUT, content: rendered.siteConf },
    { path: HEADERS_OUTPUT, content: rendered.securityHeaders },
  ];

  if (!check) {
    for (const { path, content } of files) {
      writeFileSync(path, content, 'utf8');
      console.log(`rendered ${relative(REPO_ROOT, path)}`);
    }
    console.log(
      `LUMIBOOT_DOMAIN=${readSetting(env, 'LUMIBOOT_DOMAIN', DEFAULTS.domain)} ` +
        `LUMIBOOT_HTTP_PORT=${readSetting(env, 'LUMIBOOT_HTTP_PORT', String(DEFAULTS.httpPort))} ` +
        `LUMIBOOT_PROXY_PORT=${readSetting(env, 'LUMIBOOT_PROXY_PORT', String(DEFAULTS.proxyPort))}`,
    );
    return 0;
  }

  const drifted = [];
  for (const { path, content } of files) {
    let current;
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      drifted.push(`${relative(REPO_ROOT, path)}: missing`);
      continue;
    }
    if (normalize(current) !== normalize(content)) {
      drifted.push(`${relative(REPO_ROOT, path)}: differs from its template`);
    }
  }

  if (drifted.length > 0) {
    console.error('nginx configuration is out of date:');
    for (const line of drifted) console.error(`  ${line}`);
    console.error('Run `pnpm config:nginx` and commit the rendered files.');
    return 1;
  }

  console.log('nginx configuration is up to date');
  return 0;
}

const scriptPath = process.argv[1];
const invokedDirectly =
  scriptPath !== undefined && import.meta.url === pathToFileURL(scriptPath).href;

if (invokedDirectly) {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== '--check');
  try {
    if (unknown.length > 0) {
      throw new Error(`unknown argument ${unknown.join(' ')} (usage: --check)`);
    }
    process.exitCode = main({ check: args.includes('--check') });
  } catch (error) {
    console.error(`render-nginx-config: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
