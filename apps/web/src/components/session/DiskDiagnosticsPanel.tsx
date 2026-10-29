import { useCallback, useEffect, useRef, useState } from 'react';
import { getDiskLog, getDiskSummary } from '@lumiboot/provider-v86';
import {
  diagnosticsHealth,
  formatDiskDiagnostics,
  healthMessage,
  redactDiagnosticsUrl,
  statusesLabel,
  type DiagnosticsHealth,
  type DiagnosticsReport,
} from './disk-diagnostics-format';
import {
  formatRepairReport,
  repairBrowserStorage,
  type RepairOutcome,
} from './browser-storage-reset';

export interface DiskDiagnosticsPanelProps {
  /** Tests open it directly; the session keeps it collapsed by default. */
  defaultOpen?: boolean;
}

const VISIBLE_ENTRIES = 10;

/** Collapsed: the header must stay honest, 2 s is plenty. */
const COLLAPSED_POLL_MS = 2000;
const OPEN_POLL_MS = 1000;

function readReport(): DiagnosticsReport {
  return {
    summary: getDiskSummary(),
    entries: getDiskLog().slice(-VISIBLE_ENTRIES),
  };
}

/** Fingerprint of what the panel renders: a tick re-renders only when it changes. */
function reportSignature(report: DiagnosticsReport): string {
  const { summary, entries } = report;
  const statuses = Object.keys(summary.byStatus)
    .sort()
    .map((status) => `${status}=${summary.byStatus[status]}`)
    .join(',');
  return [
    summary.requests,
    summary.allZero,
    summary.fallbacks,
    statuses,
    diagnosticsHealth(summary, entries),
    summary.serviceWorkerUrl ?? '',
  ].join('|');
}

function healthClass(health: DiagnosticsHealth): string {
  return `session-disk-diagnostics__health session-disk-diagnostics__health--${health}`;
}

/** Collapsed by default so it never competes with the guest screen. */
export function DiskDiagnosticsPanel({ defaultOpen = false }: DiskDiagnosticsPanelProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [report, setReport] = useState<DiagnosticsReport>(readReport);
  const [copied, setCopied] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [repair, setRepair] = useState<RepairOutcome | null>(null);
  const copyTimer = useRef<number | undefined>(undefined);
  const reportRef = useRef(report);

  /** Re-reads the ring buffer and re-renders only on a real change. */
  const refresh = useCallback((): void => {
    const next = readReport();
    if (reportSignature(next) === reportSignature(reportRef.current)) return;
    reportRef.current = next;
    setReport(next);
  }, []);

  // Poll even when collapsed so the header never lies.
  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, open ? OPEN_POLL_MS : COLLAPSED_POLL_MS);
    return () => window.clearInterval(timer);
  }, [open, refresh]);

  useEffect(() => {
    return () => {
      if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current);
    };
  }, []);

  const copy = useCallback(async (): Promise<void> => {
    const text = formatDiskDiagnostics(report);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }, [report]);

  const repairStorage = useCallback(async (): Promise<void> => {
    setRepairing(true);
    try {
      setRepair(await repairBrowserStorage());
    } finally {
      setRepairing(false);
    }
  }, []);

  const reload = useCallback((): void => {
    if (typeof location !== 'undefined' && typeof location.reload === 'function') {
      location.reload();
    }
  }, []);

  const { summary, entries } = report;
  const health = diagnosticsHealth(summary, entries);

  return (
    <details
      className="session-disk-diagnostics"
      data-testid="disk-diagnostics"
      data-state={health}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{`Disk diagnostics · ${summary.requests} read(s) · ${health}`}</summary>
      <div className="session-disk-diagnostics__body">
        <p
          className={healthClass(health)}
          data-state={health}
          data-testid="disk-diagnostics-health"
          role="status"
        >
          {healthMessage(health)}
        </p>
        <dl className="session-disk-diagnostics__counters">
          <div>
            <dt>Requests</dt>
            <dd data-testid="disk-diagnostics-requests">{summary.requests}</dd>
          </div>
          <div>
            <dt>Statuses</dt>
            <dd data-testid="disk-diagnostics-statuses">{statusesLabel(summary)}</dd>
          </div>
          <div>
            <dt>All-zero reads</dt>
            <dd data-testid="disk-diagnostics-all-zero">{summary.allZero}</dd>
          </div>
          <div>
            <dt>Service worker</dt>
            <dd
              className={
                summary.serviceWorkerUrl === null ? undefined : 'session-disk-diagnostics__suspect'
              }
              data-testid="disk-diagnostics-service-worker"
            >
              {summary.serviceWorkerUrl ?? 'none'}
            </dd>
          </div>
        </dl>
        {entries.length > 0 ? (
          <ul className="session-disk-diagnostics__log">
            {entries.map((entry, index) => (
              <li key={`${entry.at}-${index}`} title={redactDiagnosticsUrl(entry.url)}>
                <code>{entry.range ?? 'no range'}</code> → {entry.status ?? 'pending'} / allZero=
                {entry.allZero === null ? 'n/a' : String(entry.allZero)} / {entry.durationMs} ms
              </li>
            ))}
          </ul>
        ) : null}
        <div className="session-disk-diagnostics__repair">
          <button
            type="button"
            className="session-disk-diagnostics__action"
            disabled={repairing}
            onClick={() => {
              void repairStorage();
            }}
          >
            {repairing ? 'Repairing…' : 'Repair browser storage'}
          </button>
          <p
            className="session-disk-diagnostics__repair-report"
            data-testid="disk-diagnostics-repair-report"
            aria-live="polite"
          >
            {repair === null ? '' : formatRepairReport(repair)}
          </p>
          {repair !== null ? (
            <p className="session-disk-diagnostics__repair-hint">
              Reload the page to boot with the clean transport.{' '}
              <button
                type="button"
                className="session-disk-diagnostics__action session-disk-diagnostics__action--inline"
                onClick={reload}
              >
                Reload
              </button>
            </p>
          ) : null}
        </div>
        <button
          type="button"
          className="session-disk-diagnostics__copy"
          onClick={() => {
            void copy();
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </details>
  );
}
