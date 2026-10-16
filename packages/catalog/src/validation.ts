import { osCatalogSchema, type OSDefinition } from '@lumiboot/contracts';
import { CatalogValidationError, type CatalogIssue } from './errors';

/**
 * Valide un catalogue brut (données potentiellement non fiables : fichier
 * généré, manifeste JSON, contribution externe) avant utilisation.
 *
 * Contrôles : schéma Zod (champs, types, formats) + unicité des `id` et `slug`.
 */
export function validateCatalog(input: unknown): OSDefinition[] {
  const result = osCatalogSchema.safeParse(input);
  if (!result.success) {
    const issues: CatalogIssue[] = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    throw new CatalogValidationError(issues);
  }

  const catalog = result.data;
  const issues: CatalogIssue[] = [];
  const seenIds = new Set<string>();
  const seenSlugs = new Set<string>();

  catalog.forEach((system, index) => {
    if (seenIds.has(system.id)) {
      issues.push({ path: `${index}.id`, message: `identifiant dupliqué « ${system.id} »` });
    }
    seenIds.add(system.id);
    if (seenSlugs.has(system.slug)) {
      issues.push({ path: `${index}.slug`, message: `slug dupliqué « ${system.slug} »` });
    }
    seenSlugs.add(system.slug);
  });

  // Intégrité des groupes de variantes : un enfant doit pointer vers une cible
  // EXISTANTE qui est bien une mère (jamais un autre enfant), et ne peut pas
  // être son propre groupe.
  const systemsById = new Map(catalog.map((system) => [system.id, system] as const));
  catalog.forEach((system, index) => {
    const groupId = system.variantGroupId;
    if (groupId === undefined) return;

    if (groupId === system.id) {
      issues.push({
        path: `${index}.variantGroupId`,
        message: `un système ne peut pas être son propre groupe de variantes « ${groupId} »`,
      });
      return;
    }

    const target = systemsById.get(groupId);
    if (!target) {
      issues.push({
        path: `${index}.variantGroupId`,
        message: `groupe de variantes introuvable « ${groupId} »`,
      });
      return;
    }

    if (target.variantGroupId !== undefined) {
      issues.push({
        path: `${index}.variantGroupId`,
        message: `le groupe de variantes « ${groupId} » est lui-même un variant (la cible doit être une mère)`,
      });
    }
  });

  if (issues.length > 0) throw new CatalogValidationError(issues);

  return catalog;
}
