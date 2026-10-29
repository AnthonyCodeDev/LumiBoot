export interface CatalogIssue {
  path: string;
  message: string;
}

export class CatalogValidationError extends Error {
  readonly issues: readonly CatalogIssue[];

  constructor(issues: readonly CatalogIssue[]) {
    super(
      `Invalid catalog (${issues.length} issue(s)): ` +
        issues.map((issue) => `${issue.path || '<root>'} — ${issue.message}`).join('; '),
    );
    this.name = 'CatalogValidationError';
    this.issues = issues;
  }
}
