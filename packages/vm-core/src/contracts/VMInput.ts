/**
 * Contrat d'ENTRÉE d'un moteur, indépendant du moteur lui-même.
 *
 * Il décrit COMMENT la souris et le clavier sont livrés à l'invité, ce qui fixe
 * la stratégie de capture de l'UI générique :
 *
 * - `capture` : Pointer Lock. Un SEUL curseur reste visible (celui de l'invité) ;
 *   le navigateur livre les mouvements relatifs au moteur. Un clic explicite
 *   capture, et `Échap` / perte de focus / démontage libèrent.
 * - `absolute` : le moteur gère déjà un pointeur absolu ; l'UI ne capture rien.
 *
 * Ce fichier reste volontairement pur (aucun type ni API du DOM).
 */

/** Mode de pointeur d'un moteur sur l'écran. */
export type VMInputPointerMode = 'capture' | 'absolute';

/**
 * Contrat d'entrée. `escape` (libération par `Échap`) et `blur` (libération à la
 * perte de focus de la page) sont les garanties minimales de restitution du
 * curseur hôte : un moteur qui ne peut pas les honorer doit le déclarer.
 */
export interface VMInput {
  /** Stratégie de pointeur : `capture` implique le Pointer Lock. */
  readonly pointer: VMInputPointerMode;
  /** Le verrou se libère sur `Échap` (comportement natif du navigateur). */
  readonly releaseOnEscape: boolean;
  /** Le verrou se libère quand la page/fenêtre perd le focus. */
  readonly releaseOnBlur: boolean;
}

/** Implémentation standard : capture explicite, restituée par `Échap`/blur. */
export const STANDARD_VM_INPUT: VMInput = {
  pointer: 'capture',
  releaseOnEscape: true,
  releaseOnBlur: true,
};
