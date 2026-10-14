import type { V86, V86Options } from 'v86';

/**
 * Chargement et instanciation réels de la bibliothèque v86.
 *
 * L'import est dynamique afin que v86 (et son WASM) ne soit jamais inclus dans
 * le bundle initial : il n'est chargé qu'au moment où l'utilisateur démarre une
 * session. La construction est injectable pour rester testable sans charger le
 * WASM ni un vrai émulateur.
 */
export type V86Constructor = new (options: V86Options) => V86;

/** Charge la classe `V86` depuis le paquet npm installé. */
export type V86ModuleLoader = () => Promise<V86Constructor>;

/** Factory d'une instance neuve (jamais un singleton partagé). */
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
