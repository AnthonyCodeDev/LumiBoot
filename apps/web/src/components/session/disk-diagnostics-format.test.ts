import { describe, expect, it } from 'vitest';
import type { DiskDiagnosticsSummary, DiskRequestLogEntry } from '@lumiboot/provider-v86';
import {
  ALL_ZERO_SUSPECT_MIN_READS,
  diagnosticsHealth,
  formatDiskDiagnostics,
  HEALTH_MESSAGES,
  redactDiagnosticsUrl,
  statusesLabel,
} from './disk-diagnostics-format';
import { DISK_ASSET_URL, DISK_ASSET_URL_REDACTED } from '../../test/fixtures';

function summary(overrides: Partial<DiskDiagnosticsSummary> = {}): DiskDiagnosticsSummary {
  return {
    requests: 0,
    byStatus: {},
    allZero: 0,
    fallbacks: 0,
    transports: { fetch: 0, xhr: 0 },
    serviceWorkerUrl: null,
    userAgent: 'ua',
    lastRequestAt: null,
    ...overrides,
  };
}

function errorEntry(): DiskRequestLogEntry {
  return {
    at: 0,
    url: '/images/rootfs.img',
    range: 'bytes=0-3',
    status: 206,
    contentRange: 'bytes 0-3/1024',
    byteLength: null,
    durationMs: 1,
    allZero: null,
    transport: 'fetch',
    fallback: false,
    error: 'body stream aborted',
  };
}

describe('diagnosticsHealth', () => {
  it('is unknown before any read', () => {
    expect(diagnosticsHealth(summary())).toBe('unknown');
    expect(HEALTH_MESSAGES.unknown).toBe('No disk read recorded yet.');
  });

  it('is healthy for the few empty blocks of a real ext4 image', () => {
    // 3 % of 200 reads, as measured on a real Debian boot.
    const health = diagnosticsHealth(
      summary({ requests: 200, allZero: 6, byStatus: { '206': 200 } }),
    );
    expect(health).toBe('healthy');
    expect(HEALTH_MESSAGES[health]).toBe('All disk reads served as ranged content.');
    expect(HEALTH_MESSAGES[health]).not.toMatch(/clear this site/i);
  });

  it('is suspect when every read is zeroed', () => {
    expect(
      diagnosticsHealth(summary({ requests: 200, allZero: 200, byStatus: { '206': 200 } })),
    ).toBe('suspect');
  });

  it('does not flag a small all-zero sample', () => {
    const reads = ALL_ZERO_SUSPECT_MIN_READS - 1;
    expect(
      diagnosticsHealth(summary({ requests: reads, allZero: reads, byStatus: { '206': reads } })),
    ).toBe('healthy');
  });

  it('is suspect for a single status that is not 206', () => {
    for (const status of ['200', '404', '416', '0', '304']) {
      expect(diagnosticsHealth(summary({ requests: 1, byStatus: { [status]: 1 } }))).toBe(
        'suspect',
      );
    }
  });

  it('is suspect when a read failed', () => {
    expect(diagnosticsHealth(summary({ requests: 1, byStatus: { error: 1 } }))).toBe('suspect');
    expect(
      diagnosticsHealth(summary({ requests: 1, byStatus: { '206': 1 } }), [errorEntry()]),
    ).toBe('suspect');
  });

  it('tolerates a still-pending status', () => {
    expect(diagnosticsHealth(summary({ requests: 1, byStatus: { pending: 1 } }))).toBe('healthy');
  });
});

describe('redactDiagnosticsUrl', () => {
  it('drops the query string and the fragment', () => {
    expect(redactDiagnosticsUrl('/images/win/disk.img?token=SECRET')).toBe('/images/win/disk.img');
    expect(redactDiagnosticsUrl('/images/win/disk.img?token=SECRET#frag')).toBe(
      '/images/win/disk.img',
    );
  });

  it('keeps the origin of an absolute URL but not its secret', () => {
    expect(redactDiagnosticsUrl(DISK_ASSET_URL)).toBe(DISK_ASSET_URL_REDACTED);
  });

  it('returns an unparsable value unchanged', () => {
    expect(redactDiagnosticsUrl('')).toBe('');
    expect(redactDiagnosticsUrl('???')).toBe('???');
  });
});

describe('formatDiskDiagnostics', () => {
  it('exposes the health verdict and the statuses', () => {
    const text = formatDiskDiagnostics({
      summary: summary({ requests: 2, allZero: 1, byStatus: { '206': 2 } }),
      entries: [],
    });

    expect(text).toContain('health: healthy');
    expect(text).toContain('requests: 2');
    expect(text).toContain('statuses: 206 × 2');
    expect(text).toContain('serviceWorkerController: none');
  });

  it('never leaks an access token from a disk URL or the page URL', () => {
    const entry: DiskRequestLogEntry = {
      ...errorEntry(),
      url: DISK_ASSET_URL,
    };
    const text = formatDiskDiagnostics({
      summary: summary({ requests: 1, byStatus: { '206': 1 } }),
      entries: [entry],
    });

    expect(text).not.toContain('SECRET');
    expect(text).toContain('/images/win/disk.img');
    if (typeof location !== 'undefined') {
      expect(text).toContain(`page: ${redactDiagnosticsUrl(location.href)}`);
    }
  });

  it('formats an empty log without throwing', () => {
    const text = formatDiskDiagnostics({ summary: summary(), entries: [] });

    expect(text).toContain('requests: 0');
    expect(text).toContain('health: unknown');
    expect(text).toContain('statuses: none');
    expect(statusesLabel(summary())).toBe('none');
  });
});
