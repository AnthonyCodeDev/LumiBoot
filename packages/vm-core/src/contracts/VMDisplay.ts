/**
 * Contrat d'AFFICHAGE d'un moteur, indépendant du moteur lui-même.
 *
 * Un moteur expose les éléments où il dessine (écran principal, sortie texte)
 * en les balisant avec le marqueur standard `data-vm-display`. L'UI générique
 * retrouve ainsi les CIBLES RÉELLES du rendu, du Pointer Lock et du plein écran
 * SANS jamais citer un moteur précis (`.v86-screen`, …). Un futur moteur non
 * v86 n'a qu'à poser les mêmes marqueurs pour être pris en charge tel quel.
 *
 * Ce fichier reste volontairement pur (aucun type ni API du DOM) : `vm-core`
 * orchestre, il ne touche pas au moteur de rendu.
 */

/** Attribut DOM standard identifiant un élément d'affichage d'un moteur. */
export const VM_DISPLAY_ATTRIBUTE = 'data-vm-display';

/** Rôles d'affichage reconnus par l'UI générique. */
export const VM_DISPLAY_ROLES = {
  /** Écran principal : cible du rendu, du Pointer Lock et du plein écran. */
  screen: 'screen',
  /** Sortie texte (console) : lecture et diagnostic. */
  text: 'text',
} as const;

export type VMDisplayRole = (typeof VM_DISPLAY_ROLES)[keyof typeof VM_DISPLAY_ROLES];

/** Sélecteur CSS d'un rôle d'affichage (ex. `[data-vm-display="screen"]`). */
export function vmDisplaySelector(role: VMDisplayRole): string {
  return `[${VM_DISPLAY_ATTRIBUTE}="${role}"]`;
}

/**
 * Contrat d'affichage : cibles réelles décrites par des sélecteurs CSS, sans
 * dépendre d'un moteur ni du DOM. La cible `screen` est UNIQUE et partagée par
 * le rendu, le Pointer Lock et le plein écran : jamais deux éléments distincts.
 */
export interface VMDisplay {
  /** Sélecteur de l'écran principal (rendu + pointer + plein écran). */
  readonly screenSelector: string;
  /** Sélecteur de la sortie texte. */
  readonly textSelector: string;
}

/**
 * Implémentation standard du contrat, que tout moteur DOM doit respecter.
 * C'est le repli de l'UI générique quand aucun moteur ne fournit de contrat.
 */
export const STANDARD_VM_DISPLAY: VMDisplay = {
  screenSelector: vmDisplaySelector(VM_DISPLAY_ROLES.screen),
  textSelector: vmDisplaySelector(VM_DISPLAY_ROLES.text),
};
