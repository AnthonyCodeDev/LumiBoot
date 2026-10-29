import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, loadEnvFile, parseEnv } from '../scripts/lib/load-env.mjs';

// Shared `.env` reader: shell variables win, a missing file is never an error.

function withEnvFile(content: string, run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'lumiboot-env-'));
  const path = join(dir, '.env');
  writeFileSync(path, content, 'utf8');
  try {
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('parseEnv', () => {
  it('parses keys, values, comments and blank lines', () => {
    const parsed = parseEnv(
      [
        '# a comment',
        '',
        'FOO=bar',
        '  SPACED  =  value with spaces  ',
        'EMPTY=',
        '  # indented comment',
      ].join('\n'),
    );
    expect(parsed).toEqual({
      FOO: 'bar',
      SPACED: 'value with spaces',
      EMPTY: '',
    });
  });

  it('keeps quotes rules: double quotes expand \\n, single quotes stay literal', () => {
    const parsed = parseEnv(
      ['DOUBLE="line1\\nline2"', "SINGLE='line1\\nline2'", 'TAB="a\\tb"'].join('\n'),
    );
    expect(parsed.DOUBLE).toBe('line1\nline2');
    expect(parsed.SINGLE).toBe('line1\\nline2');
    expect(parsed.TAB).toBe('a\tb');
  });

  it('keeps `=` inside values and drops trailing comments after unquoted values', () => {
    const parsed = parseEnv(
      ['QUERY=a=b=c', 'URL=https://example.test/path#fragment', 'TRAILING=value # note'].join('\n'),
    );
    expect(parsed.QUERY).toBe('a=b=c');
    expect(parsed.URL).toBe('https://example.test/path#fragment');
    expect(parsed.TRAILING).toBe('value');
  });

  it('ignores malformed lines without throwing', () => {
    const parsed = parseEnv(['NO_EQUALS', '=missing-key', '1INVALID=x', 'OK=1'].join('\r\n'));
    expect(parsed).toEqual({ OK: '1' });
  });
});

describe('loadEnvFile', () => {
  it('loads the file values when the environment is empty', () => {
    withEnvFile('FOO=from-file\nBAR=2', (path) => {
      const env: Record<string, string | undefined> = {};
      const merged = loadEnvFile(path, env);
      expect(merged.FOO).toBe('from-file');
      expect(merged.BAR).toBe('2');
      // The target is filled in for callers that rely on `process.env`.
      expect(env.FOO).toBe('from-file');
      expect(env.BAR).toBe('2');
    });
  });

  it('never overrides a variable already present in the environment', () => {
    withEnvFile('FOO=from-file\nBAR=2', (path) => {
      const env: Record<string, string | undefined> = { FOO: 'from-shell' };
      const merged = loadEnvFile(path, env);
      expect(merged.FOO).toBe('from-shell');
      expect(merged.BAR).toBe('2');
      expect(env.FOO).toBe('from-shell');
    });
  });

  it('treats an empty shell value as present', () => {
    withEnvFile('FOO=from-file', (path) => {
      const env: Record<string, string | undefined> = { FOO: '' };
      expect(loadEnvFile(path, env).FOO).toBe('');
    });
  });

  it('returns the environment unchanged when the file is missing', () => {
    const env: Record<string, string | undefined> = { FOO: 'kept' };
    expect(loadEnvFile(join(tmpdir(), 'lumiboot-env-does-not-exist', '.env'), env)).toEqual(env);
  });

  it('exposes the repository root', () => {
    expect(existsSync(join(REPO_ROOT, 'package.json'))).toBe(true);
  });
});
