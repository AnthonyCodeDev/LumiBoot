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

  if (issues.length > 0) throw new CatalogValidationError(issues);

  return catalog;
}
