/**
 * `capture` means Pointer Lock: one cursor, relative movements delivered to the
 * engine. `absolute` means the engine handles the pointer and the UI captures
 * nothing. This file stays free of DOM types.
 */

export type VMInputPointerMode = 'capture' | 'absolute';

/** Minimal guarantees for returning the host cursor. */
export interface VMInput {
  readonly pointer: VMInputPointerMode;
  readonly releaseOnEscape: boolean;
  readonly releaseOnBlur: boolean;
}

/** Explicit capture, released by `Escape` or blur. */
export const STANDARD_VM_INPUT: VMInput = {
  pointer: 'capture',
  releaseOnEscape: true,
  releaseOnBlur: true,
};
