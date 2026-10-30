import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen as testingScreen } from '@testing-library/react';
import { LOG_ACTIVITY_STEPS, SessionLogActivity, logActivityStep } from './SessionLogActivity';

/** Console fixture: a bare `.session-console` holding the v86 serial textarea. */
function makeConsole(): { ref: { current: HTMLDivElement }; serial: HTMLTextAreaElement } {
  const container = document.createElement('div');
  container.className = 'session-console';
  const serial = document.createElement('textarea');
  serial.className = 'v86-serial';
  container.append(serial);
  document.body.append(container);
  return { ref: { current: container }, serial };
}

/** The mounted badge. */
function ring(): HTMLElement {
  return testingScreen.getByTestId('session-log-activity');
}

describe('logActivityStep — cycle 1 → 30 → 1', () => {
  it('hides the ring with no line, then cycles every 30 lines', () => {
    expect(LOG_ACTIVITY_STEPS).toBe(30);
    expect(logActivityStep(0)).toBe(0);
    expect(logActivityStep(-3)).toBe(0);
    expect(logActivityStep(1)).toBe(1);
    expect(logActivityStep(30)).toBe(30);
    expect(logActivityStep(31)).toBe(1);
    expect(logActivityStep(61)).toBe(1);
    expect(logActivityStep(60)).toBe(30);
  });
});

describe('SessionLogActivity', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays hidden until the first serial line, then follows the step', () => {
    vi.useFakeTimers();
    const { ref, serial } = makeConsole();

    render(<SessionLogActivity consoleRef={ref} />);
    expect(testingScreen.queryByTestId('session-log-activity')).toBeNull();

    serial.value = 'line1\n';
    act(() => {
      vi.advanceTimersByTime(400);
    });

    const badge = ring();
    expect(badge.getAttribute('data-step')).toBe('1');
    expect(badge.getAttribute('role')).toBe('progressbar');
    expect(badge.getAttribute('aria-valuenow')).toBe('1');
    expect(badge.getAttribute('aria-valuemax')).toBe('30');
    expect(badge.querySelector('.session-log-activity-arc')).not.toBeNull();
    // One white arc only: no faint track, no number in the middle.
    expect(badge.querySelector('.session-log-activity-track')).toBeNull();
    expect(badge.querySelector('.session-log-activity-step')).toBeNull();
    expect(badge.textContent).toBe('');
  });

  it('reaches step 30 on the 30th line and wraps back to 1 on the 31st', () => {
    vi.useFakeTimers();
    const { ref, serial } = makeConsole();

    render(<SessionLogActivity consoleRef={ref} />);

    serial.value = Array.from({ length: 30 }, (_, index) => `line${index + 1}`).join('\n');
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(ring().getAttribute('data-step')).toBe('30');

    serial.value += '\nline31';
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(ring().getAttribute('data-step')).toBe('1');
    expect(ring().getAttribute('aria-valuenow')).toBe('1');
  });

  it('is active while lines arrive, idles at 3 s, fades out at 5 s, then comes back active', () => {
    vi.useFakeTimers();
    const { ref, serial } = makeConsole();

    render(<SessionLogActivity consoleRef={ref} />);

    serial.value = 'line1\n';
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(ring().getAttribute('data-state')).toBe('active');

    // Just under the 3 s threshold: still active, and the ring keeps being polled.
    act(() => {
      vi.advanceTimersByTime(2800);
    });
    expect(ring().getAttribute('data-state')).toBe('active');

    // 3 s without a new line: the idle "loading" pulse kicks in.
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(ring().getAttribute('data-state')).toBe('idle');
    expect(ring().getAttribute('data-step')).toBe('1');

    // Still idle a bit before the 5 s mark.
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(ring().getAttribute('data-state')).toBe('idle');

    // 5 s without a new line: fade out, but the node stays mounted for the return.
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(ring().getAttribute('data-state')).toBe('hidden');
    expect(ring().getAttribute('aria-hidden')).toBe('true');
    expect(ring().getAttribute('data-step')).toBe('1');

    // A new line brings it back active, with the notch cycle untouched (2 here).
    serial.value += 'line2\n';
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(ring().getAttribute('data-state')).toBe('active');
    expect(ring().getAttribute('data-step')).toBe('2');
    expect(ring().getAttribute('aria-hidden')).toBe('false');
  });

  it('stops polling on unmount', () => {
    vi.useFakeTimers();
    const { ref } = makeConsole();
    const { unmount } = render(<SessionLogActivity consoleRef={ref} />);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
