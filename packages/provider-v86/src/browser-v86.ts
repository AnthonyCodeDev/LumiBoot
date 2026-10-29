import type { V86, V86Options } from 'v86';

/** Dynamic import: v86 and its WASM stay out of the initial bundle. */
export type V86Constructor = new (options: V86Options) => V86;

export type V86ModuleLoader = () => Promise<V86Constructor>;

/** Never a shared singleton. */
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
