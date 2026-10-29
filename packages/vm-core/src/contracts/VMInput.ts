/** `capture` = Pointer Lock; `absolute` = the engine handles the pointer. */
export type VMInputPointerMode = 'capture' | 'absolute';

export interface VMInput {
  readonly pointer: VMInputPointerMode;
  readonly releaseOnEscape: boolean;
  readonly releaseOnBlur: boolean;
}

export const STANDARD_VM_INPUT: VMInput = {
  pointer: 'capture',
  releaseOnEscape: true,
  releaseOnBlur: true,
};
