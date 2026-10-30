import { useEffect, useRef, useState, type RefObject } from 'react';

/** Number of notches in the loop: the ring goes 1 → 2 → … → 30, then back to 1. */
export const LOG_ACTIVITY_STEPS = 30;

const SERIAL_POLL_MS = 400;
/** Delay without any new serial line before the ring switches to its idle "loading" pulse. */
export const IDLE_AFTER_MS = 3000;
/** Longer silence: the badge fades out but stays mounted, so it can fade back in. */
export const HIDE_AFTER_MS = 5000;
/** Circle geometry inside the 40 × 40 viewBox (thin 2.75px pure-white arc). */
const RADIUS = 16;
const STROKE_WIDTH = 2.75;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Step (cran) shown for a given serial line count.
 *
 * Every new serial line advances the ring by one notch, cycling forever:
 * 1 → 2 → … → 30 → 1 → … Line 1 → 1, line 30 → 30, line 31 → 1, line 61 → 1.
 * An empty console returns 0, which hides the indicator entirely.
 */
export function logActivityStep(lineCount: number): number {
  if (lineCount <= 0) return 0;
  return ((lineCount - 1) % LOG_ACTIVITY_STEPS) + 1;
}

/**
 * Serial line count of a raw v86 buffer.
 *
 * A trailing newline closes the last line instead of opening an empty one, so
 * `"line1\n"` counts as 1 line and `"line1\nline2\n"` as 2.
 */
function countSerialLines(value: string): number {
  if (value.length === 0) return 0;
  const lines = value.split(/\r?\n/);
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

export interface SessionLogActivityProps {
  /** `.session-console`, which holds the `textarea.v86-serial`. */
  consoleRef: RefObject<HTMLDivElement>;
}

/** Visual state of the badge: moving, pulsing, or faded out. */
type LogActivityState = 'active' | 'idle' | 'hidden';

/** State for a given silence duration (ms since the last real buffer change). */
function logActivityState(silentFor: number): LogActivityState {
  if (silentFor >= HIDE_AFTER_MS) return 'hidden';
  if (silentFor >= IDLE_AFTER_MS) return 'idle';
  return 'active';
}

/**
 * Discreet log-activity ring in the top right of `.session-viewport`.
 *
 * v86 keeps writing into `textarea.v86-serial` even when the logs are hidden, so
 * polling that buffer shows at a glance whether the guest still logs anything.
 * Mounted next to the console (never inside it): v86 owns the console subtree.
 *
 * The ring fills with one notch per new serial line (1 → 30 → 1). When nothing
 * moved for {@link IDLE_AFTER_MS} the container switches to `data-state="idle"`
 * so CSS can play a slow "loading" pulse; past {@link HIDE_AFTER_MS} it goes
 * `data-state="hidden"` and fades out, still mounted so the next line brings it
 * back with a fade in (the notch cycle is never reset).
 */
export function SessionLogActivity({ consoleRef }: SessionLogActivityProps) {
  const [step, setStep] = useState(0);
  const [state, setState] = useState<LogActivityState>('active');
  // Length of the last buffer read: same length means no new line, no re-split.
  const lastLength = useRef(-1);
  // Timestamp of the last real change, not of the last poll tick.
  const lastChangeAt = useRef(Date.now());

  useEffect(() => {
    const read = () => {
      const serial = consoleRef.current?.querySelector<HTMLTextAreaElement>('textarea.v86-serial');
      const value = serial?.value ?? '';
      if (value.length !== lastLength.current) {
        lastLength.current = value.length;
        lastChangeAt.current = Date.now();
        setStep(logActivityStep(countSerialLines(value)));
      }
      // Evaluated on every tick, even when the buffer did not move.
      setState(logActivityState(Date.now() - lastChangeAt.current));
    };
    read();
    const timer = window.setInterval(read, SERIAL_POLL_MS);
    return () => window.clearInterval(timer);
  }, [consoleRef]);

  if (step <= 0) return null;

  const filled = step / LOG_ACTIVITY_STEPS;

  return (
    <div
      className="session-log-activity"
      data-step={step}
      data-state={state}
      data-testid="session-log-activity"
      role="progressbar"
      aria-label="Log activity"
      aria-valuemin={1}
      aria-valuemax={LOG_ACTIVITY_STEPS}
      aria-valuenow={step}
      aria-hidden={state === 'hidden'}
    >
      <svg viewBox="0 0 40 40" aria-hidden="true" focusable="false">
        <circle
          className="session-log-activity-arc"
          cx="20"
          cy="20"
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE_WIDTH}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - filled)}
          transform="rotate(-90 20 20)"
        />
      </svg>
    </div>
  );
}
