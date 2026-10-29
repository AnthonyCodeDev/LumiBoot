import type { DiskDiagnosticsSummary, DiskRequestLogEntry } from '@lumiboot/provider-v86';

export interface DiagnosticsReport {
  readonly summary: DiskDiagnosticsSummary;
  readonly entries: DiskRequestLogEntry[];
}

/** Three-valued verdict, so a healthy profile never shows a purge advice. */
export type DiagnosticsHealth = 'healthy' | 'suspect' | 'unknown';

/** A broken profile answers zeros to (almost) every read; a healthy one only a few percent. */
export const ALL_ZERO_SUSPECT_SHARE = 0.5;
export const ALL_ZERO_SUSPECT_MIN_READS = 20;

/** `pending` is a status that has not arrived yet, not a wrong one. */
const RANGED_STATUSES = new Set(['206', 'pending']);

export const HEALTH_MESSAGES: Readonly<Record<DiagnosticsHealth, string>> = {
  healthy: 'All disk reads served as ranged content.',
  suspect:
    "Some disk reads were not ranged content (status ≠ 206) or returned only zeros. Clear this site's data and unregister the service worker for this origin, then reload.",
  unknown: 'No disk read recorded yet.',
};

export function statusesLabel(summary: DiskDiagnosticsSummary): string {
  const entries = Object.entries(summary.byStatus);
  if (entries.length === 0) return 'none';
  return entries.map(([status, count]) => `${status} × ${count}`).join(', ');
}

function allStatusesAreRanged(summary: DiskDiagnosticsSummary): boolean {
  return Object.entries(summary.byStatus).every(
    ([status, count]) => count === 0 || RANGED_STATUSES.has(status),
  );
}

function zeroShareIsOverwhelming(summary: DiskDiagnosticsSummary): boolean {
  if (summary.requests < ALL_ZERO_SUSPECT_MIN_READS) return false;
  return summary.allZero / summary.requests >= ALL_ZERO_SUSPECT_SHARE;
}

/** `suspect` on a failed read, a non-ranged status, or an overwhelming all-zero share. */
export function diagnosticsHealth(
  summary: DiskDiagnosticsSummary,
  entries: readonly DiskRequestLogEntry[] = [],
): DiagnosticsHealth {
  if (summary.requests <= 0) return 'unknown';
  if (entries.some((entry) => entry.error !== undefined)) return 'suspect';
  if (!allStatusesAreRanged(summary)) return 'suspect';
  if (zeroShareIsOverwhelming(summary)) return 'suspect';
  return 'healthy';
}

export function healthMessage(health: DiagnosticsHealth): string {
  return HEALTH_MESSAGES[health];
}

/** Base used to parse relative disk URLs without touching the network. */
const DIAGNOSTICS_BASE_URL = 'https://lumiboot.invalid';

/** Strips query and fragment: disk requests carry an access token in `?token=`. */
export function redactDiagnosticsUrl(value: string): string {
  if (value === '') return value;
  try {
    const isAbsolute = /^[a-z][a-z0-9+.-]*:/i.test(value);
    if (!isAbsolute && !value.startsWith('/')) return value;
    const url = new URL(value, DIAGNOSTICS_BASE_URL);
    url.search = '';
    url.hash = '';
    // The fake base must never reach a report.
    return isAbsolute ? url.toString() : url.pathname;
  } catch {
    return value;
  }
}

export function formatDiskDiagnostics(report: DiagnosticsReport): string {
  const { summary, entries } = report;
  const page = typeof location === 'undefined' ? 'unknown' : redactDiagnosticsUrl(location.href);
  const lines = [
    'LumiBoot disk diagnostics',
    `generated: ${new Date().toISOString()}`,
    `page: ${page}`,
    `userAgent: ${summary.userAgent}`,
    `serviceWorkerController: ${summary.serviceWorkerUrl ?? 'none'}`,
    `health: ${diagnosticsHealth(summary, entries)}`,
    `requests: ${summary.requests}`,
    `statuses: ${statusesLabel(summary)}`,
    `allZero: ${summary.allZero}`,
    `fallbacks: ${summary.fallbacks}`,
    `transports: fetch=${summary.transports.fetch} xhr=${summary.transports.xhr}`,
    '',
    ...entries.map(
      (entry) =>
        `${entry.range ?? 'no range'} → ${entry.status ?? 'pending'} / allZero=${
          entry.allZero === null ? 'n/a' : String(entry.allZero)
        } / ${entry.durationMs} ms / ${entry.transport} / ${redactDiagnosticsUrl(entry.url)}`,
    ),
  ];
  return lines.join('\n');
}
