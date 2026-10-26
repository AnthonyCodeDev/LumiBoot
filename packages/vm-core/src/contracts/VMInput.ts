/**
 * INPUT contract of an engine, independent of the engine itself.
 *
 * It describes HOW the mouse and keyboard are delivered to the guest, which
 * sets the capture strategy of the generic UI:
 *
 * - `capture`: Pointer Lock. A SINGLE cursor stays visible (the guest one); the
 *   browser delivers relative movements to the engine. An explicit click
 *   captures, and `Escape` / focus loss / unmount release.
 * - `absolute`: the engine already handles an absolute pointer; the UI captures
 *   nothing.
 *
 * This file intentionally stays pure (no DOM type or API).
 */

/** Pointer mode of an engine on the screen. */
export type VMInputPointerMode = 'capture' | 'absolute';

/**
 * Input contract. `escape` (release via `Escape`) and `blur` (release on page
 * focus loss) are the minimal guarantees for returning the host cursor: an
 * engine that cannot honor them must declare it.
 */
export interface VMInput {
  /** Pointer strategy: `capture` implies Pointer Lock. */
  readonly pointer: VMInputPointerMode;
  /** The lock is released on `Escape` (native browser behavior). */
  readonly releaseOnEscape: boolean;
  /** The lock is released when the page loses focus. */
  readonly releaseOnBlur: boolean;
}

/** Standard implementation: explicit capture, returned by `Escape`/blur. */
export const STANDARD_VM_INPUT: VMInput = {
  pointer: 'capture',
  releaseOnEscape: true,
  releaseOnBlur: true,
};
