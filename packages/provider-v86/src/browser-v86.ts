import type { V86, V86Options } from 'v86';

/**
 * Real loading and instantiation of the v86 library.
 *
 * The import is dynamic so v86 (and its WASM) is never included in the initial
 * bundle: it is only loaded when the user starts a session. Construction is
 * injectable to stay testable without loading the WASM or a real emulator.
 */
export type V86Constructor = new (options: V86Options) => V86;

/** Loads the `V86` class from the installed npm package. */
export type V86ModuleLoader = () => Promise<V86Constructor>;

/** Factory of a fresh instance (never a shared singleton). */
export type V86Factory = (options: V86Options) => V86 | Promise<V86>;

export const loadV86Module: V86ModuleLoader = async () => {
  const module = await import('v86');
  return module.V86;
};

export async function createBrowserV86(
  options: V86Options,
  load: V86ModuleLoader = loadV86Module,
): Promise<V86> {
  const V86Class = await load();
  return new V86Class(options);
}
