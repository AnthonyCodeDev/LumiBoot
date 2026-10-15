import type { Availability } from '@lumiboot/contracts';

/**
 * Faits objectifs servant au calcul de la disponibilité effective d'un système.
 *
 * Aucun de ces faits n'est un statut « déclaré » par une image ou un profil :
 * la disponibilité est toujours DÉRIVÉE de ces quatre conditions.
 */
export interface SystemAvailabilityFacts {
  /** Une image est réellement présente/référencée (`imageRef` renseigné). */
  readonly hasImage: boolean;
  /** Au moins un profil de lancement compatible (mode navigateur) existe. */
  readonly hasCompatibleProfile: boolean;
  /** Le moteur du profil est réellement intégré au dépôt. */
  readonly engineIntegrated: boolean;
  /** Le fonctionnement a été validé par un boot réel prouvé. */
  readonly validated: boolean;
  /** Statut de repli lorsque les conditions ne sont pas réunies. */
  readonly declared?: Availability;
}

/**
 * RÈGLE UNIQUE DE DISPONIBILITÉ.
 *
 * Un système n'est disponible (`ready`) que si TOUTES ces conditions sont
 * réunies : image présente/référencée, profil compatible, moteur intégré et
 * fonctionnement validé. Un système ne devient donc PAS disponible simplement
 * parce que son image existe.
 *
 * En l'absence de preuve, on ne retombe jamais sur `ready` : un statut déclaré
 * `ready` est rétrogradé en `planned`.
 */
export function getEffectiveAvailability(facts: SystemAvailabilityFacts): Availability {
  const available =
    facts.hasImage && facts.hasCompatibleProfile && facts.engineIntegrated && facts.validated;
  if (available) return 'ready';

  const declared = facts.declared ?? 'planned';
  return declared === 'ready' ? 'planned' : declared;
}

/**
 * Agrège la disponibilité de PLUSIEURS candidats — un candidat étant un couple
 * cohérent (image × profil × moteur).
 *
 * Correctif audit #19 : la disponibilité d'un système ne doit JAMAIS combiner la
 * validation d'un profil avec le moteur (ou la compatibilité) d'un autre. Un
 * système n'est donc `ready` que si un MÊME candidat réunit les quatre
 * conditions ; des `some()` indépendants pouvaient produire un faux `ready`.
 *
 * La règle métier reste inchangée : `ready` exige un boot réellement validé.
 */
export function getAggregatedAvailability(
  candidates: readonly SystemAvailabilityFacts[],
): Availability {
  if (candidates.some((facts) => getEffectiveAvailability(facts) === 'ready')) return 'ready';

  const declared = candidates.find((facts) => facts.declared !== undefined)?.declared;
  return declared !== undefined && declared !== 'ready' ? declared : 'planned';
}
