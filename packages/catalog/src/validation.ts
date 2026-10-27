import { osCatalogSchema, type OSDefinition } from '@lumiboot/contracts';
import { CatalogValidationError, type CatalogIssue } from './errors';

/** Zod validation plus `id`/`slug` uniqueness on untrusted input. */
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
      issues.push({ path: `${index}.id`, message: `duplicate identifier "${system.id}"` });
    }
    seenIds.add(system.id);
    if (seenSlugs.has(system.slug)) {
      issues.push({ path: `${index}.slug`, message: `duplicate slug "${system.slug}"` });
    }
    seenSlugs.add(system.slug);
  });

  // A child must point to an existing parent, never to another child or itself.
  const systemsById = new Map(catalog.map((system) => [system.id, system] as const));
  catalog.forEach((system, index) => {
    const groupId = system.variantGroupId;
    if (groupId === undefined) return;

    if (groupId === system.id) {
      issues.push({
        path: `${index}.variantGroupId`,
        message: `a system cannot be its own variant group "${groupId}"`,
      });
      return;
    }

    const target = systemsById.get(groupId);
    if (!target) {
      issues.push({
        path: `${index}.variantGroupId`,
        message: `variant group not found "${groupId}"`,
      });
      return;
    }

    if (target.variantGroupId !== undefined) {
      issues.push({
        path: `${index}.variantGroupId`,
        message: `variant group "${groupId}" is itself a variant (the target must be a parent)`,
      });
    }
  });

  if (issues.length > 0) throw new CatalogValidationError(issues);

  return catalog;
}
