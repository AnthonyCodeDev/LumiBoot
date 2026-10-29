import type { DiskDiagnosticsSummary, DiskRequestLogEntry } from '@lumiboot/provider-v86';

export interface DiagnosticsReport {
  readonly summary: DiskDiagnosticsSummary;
  readonly entries: DiskRequestLogEntry[];
}

/**
 * Three-valued verdict, so a healthy profile never shows a purge advice.
 *
 * `healthy` is the normal case: on a real ext4 image a few percent of the
 * blocks are legitimately empty, so `allZero > 0` alone proves nothing.
 */
export type DiagnosticsHealth = 'healthy' | 'suspect' | 'unknown';

/**
 * A broken profile answers zeros to (almost) every read, while a healthy one
 * only returns a few percent of empty blocks: 50 % over at least 20 reads
 * separates the two profiles without flagging a small sample by accident.
 */
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

/**
 * `suspect` only when the profile is really broken:
 * - a status that is neither `206` nor a still-pending read (`200`, `404`,
 *   `416`, `0`, unknown status, or an `error` entry);
 * - at least one read that failed;
 * - or an overwhelming share of all-zero reads (see the constants above).
 */
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

/** Full text pasted into the chat: no DevTools knowledge required. */
export function formatDiskDiagnostics(report: DiagnosticsReport): string {
  const { summary, entries } = report;
  const lines = [
    'LumiBoot disk diagnostics',
    `generated: ${new Date().toISOString()}`,
    `page: ${typeof location === 'undefined' ? 'unknown' : location.href}`,
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
        } / ${entry.durationMs} ms / ${entry.transport} / ${entry.url}`,
    ),
  ];
  return lines.join('\n');
}
