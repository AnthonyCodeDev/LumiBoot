/**
 * DISPLAY contract of an engine, independent of the engine itself.
 *
 * An engine exposes the elements it draws into (main screen, text output) by
 * tagging them with the standard `data-vm-display` marker. The generic UI then
 * finds the REAL targets of rendering, Pointer Lock and fullscreen WITHOUT ever
 * naming a specific engine (`.v86-screen`, …). A future non-v86 engine only has
 * to set the same markers to be supported as-is.
 *
 * This file intentionally stays pure (no DOM type or API): `vm-core`
 * orchestrates, it does not touch the rendering engine.
 */

/** Standard DOM attribute identifying a display element of an engine. */
export const VM_DISPLAY_ATTRIBUTE = 'data-vm-display';

/** Display roles recognized by the generic UI. */
export const VM_DISPLAY_ROLES = {
  /** Main screen: target of rendering, Pointer Lock and fullscreen. */
  screen: 'screen',
  /** Text output (console): reading and diagnostics. */
  text: 'text',
} as const;

export type VMDisplayRole = (typeof VM_DISPLAY_ROLES)[keyof typeof VM_DISPLAY_ROLES];

/** CSS selector for a display role (e.g. `[data-vm-display="screen"]`). */
export function vmDisplaySelector(role: VMDisplayRole): string {
  return `[${VM_DISPLAY_ATTRIBUTE}="${role}"]`;
}

/**
 * Display contract: real targets described by CSS selectors, without depending
 * on an engine or on the DOM. The `screen` target is UNIQUE and shared by
 * rendering, Pointer Lock and fullscreen: never two distinct elements.
 */
export interface VMDisplay {
  /** Selector of the main screen (rendering + pointer + fullscreen). */
  readonly screenSelector: string;
  /** Selector of the text output. */
  readonly textSelector: string;
}

/**
 * Standard implementation of the contract, which every DOM engine must honor.
 * It is the fallback of the generic UI when no engine provides a contract.
 */
export const STANDARD_VM_DISPLAY: VMDisplay = {
  screenSelector: vmDisplaySelector(VM_DISPLAY_ROLES.screen),
  textSelector: vmDisplaySelector(VM_DISPLAY_ROLES.text),
};
