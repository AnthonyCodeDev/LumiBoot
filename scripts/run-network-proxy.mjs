#!/usr/bin/env node
// Launches the Go network proxy with the `LUMIBOOT_PROXY_*` values of `.env`.

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT, loadEnvFile } from './lib/load-env.mjs';

const PROXY_DIR = join(REPO_ROOT, 'apps', 'network-proxy');
const ENV_PATH = join(REPO_ROOT, '.env');
const PROXY_ENV_PREFIX = 'LUMIBOOT_PROXY_';

/** Child env: current environment plus the `LUMIBOOT_PROXY_*` entries of `.env`. */
function childEnvironment() {
  const childEnv = { ...process.env };
  // An explicit target keeps `.env` from leaking into `process.env` here.
  const fileEnv = loadEnvFile(ENV_PATH, {});
  for (const [key, value] of Object.entries(fileEnv)) {
    if (!key.startsWith(PROXY_ENV_PREFIX)) continue;
    if (childEnv[key] === undefined) childEnv[key] = value;
  }
  return childEnv;
}

/** `shell: true` on Windows goes through `cmd.exe`, which needs the quotes. */
function quoteForWindowsShell(arg) {
  return /\s/.test(arg) && !arg.includes('"') ? `"${arg}"` : arg;
}

const isWindows = process.platform === 'win32';
const extraArgs = process.argv.slice(2);
// Drop one leading `--` forwarded literally by pnpm: `go run` would swallow it.
if (extraArgs[0] === '--') extraArgs.shift();
const args = ['run', './cmd/lumiboot-network', ...extraArgs];

const child = spawn('go', isWindows ? args.map(quoteForWindowsShell) : args, {
  cwd: PROXY_DIR,
  stdio: 'inherit',
  env: childEnvironment(),
  // On Windows, the shell resolves `go.exe` via PATHEXT and keeps Ctrl+C together.
  shell: isWindows,
});

child.on('error', (error) => {
  console.error(
    `run-network-proxy: cannot start "go": ${error.message}. Install Go 1.22+ and retry.`,
  );
  process.exit(1);
});

// Propagate the exit code: a failed build must fail the caller.
child.on('exit', (code, signal) => {
  if (signal !== null) {
    console.error(`run-network-proxy: stopped by ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
