/**
 * Engines tag their display elements with `data-vm-display`; the UI never names
 * a specific engine. This file stays free of DOM types.
 */

/** Standard DOM attribute identifying a display element of an engine. */
export const VM_DISPLAY_ATTRIBUTE = 'data-vm-display';

export const VM_DISPLAY_ROLES = {
  /** Rendering, Pointer Lock and fullscreen target. */
  screen: 'screen',
  /** Console text output. */
  text: 'text',
} as const;

export type VMDisplayRole = (typeof VM_DISPLAY_ROLES)[keyof typeof VM_DISPLAY_ROLES];

/** CSS selector for a display role. */
export function vmDisplaySelector(role: VMDisplayRole): string {
  return `[${VM_DISPLAY_ATTRIBUTE}="${role}"]`;
}

/**
 * `screen` is unique and shared by rendering, Pointer Lock and fullscreen.
 */
export interface VMDisplay {
  readonly screenSelector: string;
  readonly textSelector: string;
}

/** Default contract of the generic UI. */
export const STANDARD_VM_DISPLAY: VMDisplay = {
  screenSelector: vmDisplaySelector(VM_DISPLAY_ROLES.screen),
  textSelector: vmDisplaySelector(VM_DISPLAY_ROLES.text),
};
