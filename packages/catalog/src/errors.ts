export interface CatalogIssue {
  path: string;
  message: string;
}

/** Levée lorsqu'un manifeste de catalogue est invalide ou incohérent. */
export class CatalogValidationError extends Error {
  readonly issues: readonly CatalogIssue[];

  constructor(issues: readonly CatalogIssue[]) {
    super(
      `Catalogue invalide (${issues.length} problème(s)) : ` +
        issues.map((issue) => `${issue.path || '<racine>'} — ${issue.message}`).join(' ; '),
    );
    this.name = 'CatalogValidationError';
    this.issues = issues;
  }
}
