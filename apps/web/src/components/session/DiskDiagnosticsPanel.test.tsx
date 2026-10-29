import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  clearDiskLog,
  getDiskLog,
  installRangeFetchTransport,
  type XhrScope,
} from '@lumiboot/provider-v86';
import { DiskDiagnosticsPanel } from './DiskDiagnosticsPanel';
import { formatDiskDiagnostics } from './disk-diagnostics-format';

/** One 4-byte 206 served with the given body, through the real transport. */
async function seedRead(bytes: Uint8Array = new Uint8Array(4)): Promise<void> {
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const stop = installRangeFetchTransport({
    scope: window as unknown as XhrScope,
    fetchImpl: (async () =>
      ({
        ok: true,
        status: 206,
        statusText: '',
        headers: { get: () => 'bytes 0-3/1024' },
        arrayBuffer: async () => body,
      }) as unknown as Response) as typeof fetch,
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.onload = () => resolve();
      request.onerror = () => reject(new Error('disk request failed'));
      request.open('GET', '/images/debian-12-i386/rootfs.img');
      request.responseType = 'arraybuffer';
      request.setRequestHeader('Range', 'bytes=0-3');
      request.setRequestHeader('X-Accept-Encoding', 'identity');
      request.send(null);
    });
  } finally {
    stop();
  }
}

/** One 4-byte zeroed 206, the exact shape of a cached disk read. */
async function seedZeroRead(): Promise<void> {
  await seedRead();
}

describe('DiskDiagnosticsPanel', () => {
  it('shows the counters and the zeroed read, without DevTools', async () => {
    clearDiskLog();
    await seedZeroRead();

    render(<DiskDiagnosticsPanel defaultOpen />);

    expect(screen.getByTestId('disk-diagnostics-requests').textContent).toContain('1');
    expect(screen.getByTestId('disk-diagnostics-statuses').textContent).toContain('206 × 1');
    expect(screen.getByTestId('disk-diagnostics-all-zero').textContent).toContain('1');
    expect(screen.getByTestId('disk-diagnostics-service-worker').textContent).toContain('none');
    // A single empty block is legitimate: no purge advice.
    const health = screen.getByTestId('disk-diagnostics-health');
    expect(health.textContent).toBe('All disk reads served as ranged content.');
    expect(health.getAttribute('data-state')).toBe('healthy');
    expect(screen.queryByText(/not ranged content/)).toBeNull();
    expect(screen.getByText(/bytes=0-3/)).toBeTruthy();
  });

  it('says unknown before the first read', () => {
    clearDiskLog();

    render(<DiskDiagnosticsPanel defaultOpen />);

    const health = screen.getByTestId('disk-diagnostics-health');
    expect(health.getAttribute('data-state')).toBe('unknown');
    expect(health.textContent).toBe('No disk read recorded yet.');
  });

  it('renders the summary line even while collapsed', () => {
    clearDiskLog();
    render(<DiskDiagnosticsPanel />);

    expect(screen.getByText(/^Disk diagnostics/)).toBeTruthy();
    expect(screen.getByTestId('disk-diagnostics').hasAttribute('open')).toBe(false);
  });

  it('keeps the collapsed header up to date without opening', async () => {
    clearDiskLog();
    vi.useFakeTimers();
    try {
      render(<DiskDiagnosticsPanel />);
      const details = screen.getByTestId('disk-diagnostics');
      expect(details.hasAttribute('open')).toBe(false);
      expect(details.textContent).toContain('Disk diagnostics · 0 read(s) · unknown');

      // A boot reads disk blocks while the panel stays folded.
      await seedRead(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));

      // Still the mount snapshot: nothing was polled yet.
      expect(details.textContent).toContain('0 read(s) · unknown');

      act(() => {
        vi.advanceTimersByTime(2000);
      });

      expect(details.hasAttribute('open')).toBe(false);
      expect(details.textContent).toContain('Disk diagnostics · 1 read(s) · healthy');
      expect(details.getAttribute('data-state')).toBe('healthy');
    } finally {
      vi.useRealTimers();
    }
  });

  it('copies a self-contained report', async () => {
    clearDiskLog();
    await seedZeroRead();
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(<DiskDiagnosticsPanel defaultOpen />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));

    expect(writeText).toHaveBeenCalledTimes(1);
    const text = writeText.mock.calls[0]?.[0] ?? '';
    expect(text).toContain('LumiBoot disk diagnostics');
    expect(text).toContain('serviceWorkerController: none');
    expect(text).toContain('statuses: 206 × 1');
    expect(text).toContain('health: healthy');
    expect(text).toContain('allZero: 1');
  });

  it('repairs service workers and caches in one click, then invites to reload', async () => {
    clearDiskLog();
    const unregistered: string[] = [];
    const deleted: string[] = [];
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const container = {
      getRegistrations: async () => {
        await gate;
        return [0, 1].map((index) => ({
          unregister: async (): Promise<boolean> => {
            unregistered.push(String(index));
            return true;
          },
        }));
      },
    };
    const storage = {
      keys: async () => ['other-app-cache'],
      delete: async (name: string): Promise<boolean> => {
        deleted.push(name);
        return true;
      },
    };

    const previous = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container });
    vi.stubGlobal('caches', storage);

    try {
      render(<DiskDiagnosticsPanel defaultOpen />);
      const button = screen.getByRole('button', { name: 'Repair browser storage' });
      await userEvent.click(button);

      // Busy: the button is disabled while the asynchronous repair runs.
      expect((button as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByRole('button', { name: 'Repairing…' })).toBeTruthy();

      release();
      const report = await screen.findByTestId('disk-diagnostics-repair-report');
      expect(report.textContent).toBe('2 service worker(s) unregistered · 1 cache(s) cleared');
      expect(unregistered).toEqual(['0', '1']);
      expect(deleted).toEqual(['other-app-cache']);
      expect(screen.getByText(/Reload the page to boot with the clean transport/)).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, 'serviceWorker');
      } else {
        Object.defineProperty(navigator, 'serviceWorker', previous);
      }
      vi.unstubAllGlobals();
    }
  });

  it('formats an empty log without throwing', () => {
    clearDiskLog();
    const text = formatDiskDiagnostics({
      summary: {
        requests: 0,
        byStatus: {},
        allZero: 0,
        fallbacks: 0,
        transports: { fetch: 0, xhr: 0 },
        serviceWorkerUrl: null,
        userAgent: 'ua',
        lastRequestAt: null,
      },
      entries: [],
    });

    expect(text).toContain('requests: 0');
    expect(text).toContain('statuses: none');
    expect(getDiskLog()).toEqual([]);
  });
});
