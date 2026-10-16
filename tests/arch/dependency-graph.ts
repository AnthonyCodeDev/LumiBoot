import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * Outil d'analyse du graphe de dépendances de l'espace de travail.
 *
 * Il est volontairement sans dépendance externe : il lit les `package.json` et
 * les sources TypeScript, puis expose des primitives pures (graphe, cycles,
 * imports interdits) que les tests d'architecture assemblent en règles.
 *
 * Deux niveaux sont distingués :
 * - le graphe DÉCLARÉ (`package.json` → dépendances `@lumiboot/*`) ;
 * - le graphe RÉEL (imports présents dans les sources), qui doit être un
 *   sous-ensemble du premier (pas de dépendance fantôme).
 */

/** Dossiers de l'espace de travail analysés (pnpm-workspace.yaml). */
export const WORKSPACE_DIRS = ['apps', 'packages'] as const;

/** Portée des paquets internes. */
export const INTERNAL_SCOPE = '@lumiboot/';

/** Dossiers techniques jamais parcourus. */
export const IGNORED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.vite',
  'playwright-report',
  'test-results',
]);

export interface WorkspacePackage {
  /** Nom npm, ex. `@lumiboot/vm-core`. */
  readonly name: string;
  /** Chemin absolu du dossier du paquet. */
  readonly dir: string;
  /** Chemin relatif POSIX depuis la racine, ex. `packages/vm-core`. */
  readonly relDir: string;
  /** Dépendances internes déclarées, triées et dédupliquées. */
  readonly internalDeps: readonly string[];
  /** Toutes les dépendances déclarées (internes + externes), pour diagnostic. */
  readonly declaredDeps: readonly string[];
}

/** Convertit un chemin Windows en POSIX (comparaisons lisibles). */
export function toPosix(path: string): string {
  return path.split(sep).join('/');
}

/** Vrai si le nom est un paquet interne `@lumiboot/*`. */
export function isInternalPackage(name: string): boolean {
  return name.startsWith(INTERNAL_SCOPE);
}

/**
 * Extrait le nom de paquet d'un spécificateur d'import, ou `null` s'il n'est
 * pas interne. `@lumiboot/contracts` → `@lumiboot/contracts` ;
 * `@lumiboot/contracts/src/x` → `@lumiboot/contracts`.
 */
export function internalPackageFromSpecifier(specifier: string): string | null {
  if (!isInternalPackage(specifier)) return null;
  const parts = specifier.split('/');
  if (parts.length < 2) return null;
  return `${parts[0]}/${parts[1]}`;
}

/**
 * Vrai si le spécificateur est un import profond interdit
 * (`@lumiboot/contracts/src/...`), qui contournerait la surface publique.
 */
export function isDeepInternalSpecifier(specifier: string): boolean {
  const pkg = internalPackageFromSpecifier(specifier);
  if (pkg === null) return false;
  return specifier !== pkg;
}

/**
 * Lit tous les spécificateurs d'import/export/require d'un source.
 * Gère `import ... from 'x'`, `import 'x'`, `export ... from 'x'`,
 * `import('x')` et `require('x')`.
 */
export function extractModuleSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /(?:^|[^.\w])(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.add(specifier);
    }
  }
  return [...specifiers];
}

/** Liste récursivement les sources `.ts`/`.tsx` d'un dossier. */
export function collectSourceFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectSourceFiles(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) files.push(full);
  }
  return files;
}

/** Toutes les sources de l'espace de travail, hors dossiers ignorés. */
export function collectWorkspaceSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const group of WORKSPACE_DIRS) {
    const groupDir = join(root, group);
    if (!directoryExists(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) continue;
      files.push(...collectSourceFiles(join(groupDir, entry.name)));
    }
  }
  return files;
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readInternalDeps(manifest: Record<string, unknown>): string[] {
  const fields = ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies'];
  const deps = new Set<string>();
  for (const field of fields) {
    const value = manifest[field];
    if (value === null || typeof value !== 'object') continue;
    for (const name of Object.keys(value as Record<string, unknown>)) {
      if (isInternalPackage(name)) deps.add(name);
    }
  }
  return [...deps].sort();
}

function readDeclaredDeps(manifest: Record<string, unknown>): string[] {
  const fields = ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies'];
  const deps = new Set<string>();
  for (const field of fields) {
    const value = manifest[field];
    if (value === null || typeof value !== 'object') continue;
    for (const name of Object.keys(value as Record<string, unknown>)) deps.add(name);
  }
  return [...deps].sort();
}

/**
 * Lit les paquets de l'espace de travail (`apps/*`, `packages/*`).
 * Les `node_modules` imbriqués sont ignorés : un `package.json` de dépendance
 * ne doit jamais être confondu avec un paquet du dépôt.
 */
export function collectWorkspacePackages(root: string): WorkspacePackage[] {
  const packages: WorkspacePackage[] = [];
  for (const group of WORKSPACE_DIRS) {
    const groupDir = join(root, group);
    if (!directoryExists(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) continue;
      const dir = join(groupDir, entry.name);
      const manifestPath = join(dir, 'package.json');
      if (!directoryExists(dir) || !statSync(manifestPath, { throwIfNoEntry: false })) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      const name = manifest['name'];
      if (typeof name !== 'string') continue;
      packages.push({
        name,
        dir,
        relDir: toPosix(relative(root, dir)),
        internalDeps: readInternalDeps(manifest),
        declaredDeps: readDeclaredDeps(manifest),
      });
    }
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Graphe orienté d'imports réels entre paquets internes : arête
 * `source → cible` dès qu'une source du paquet `source` importe un paquet
 * interne `cible`.
 */
export function buildPackageImportGraph(
  packages: readonly WorkspacePackage[],
): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const pkg of packages) graph.set(pkg.name, new Set());
  for (const pkg of packages) {
    const edges = graph.get(pkg.name)!;
    for (const file of collectSourceFiles(join(pkg.dir, 'src'))) {
      const source = readFileSync(file, 'utf8');
      for (const specifier of extractModuleSpecifiers(source)) {
        const target = internalPackageFromSpecifier(specifier);
        if (target !== null && graph.has(target)) edges.add(target);
      }
    }
  }
  return graph;
}

/** Graphe orienté des dépendances internes DÉCLARÉES. */
export function buildDeclaredPackageGraph(
  packages: readonly WorkspacePackage[],
): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const pkg of packages) graph.set(pkg.name, new Set(pkg.internalDeps));
  return graph;
}

/**
 * Détecte les cycles d'un graphe orienté (composantes fortement connexes de
 * taille > 1, plus les auto-boucles). Renvoie chaque cycle trié pour un rapport
 * stable.
 */
export function findCycles(graph: ReadonlyMap<string, Iterable<string>>): string[][] {
  const nodes = [...graph.keys()].sort();
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  let counter = 0;

  const neighbors = (node: string): string[] => {
    const value = graph.get(node);
    return value === undefined ? [] : [...value];
  };

  // Tarjan itératif : évite tout débordement de pile sur de gros graphes.
  for (const start of nodes) {
    if (index.has(start)) continue;
    const work: Array<{ node: string; next: number }> = [{ node: start, next: 0 }];
    index.set(start, counter);
    low.set(start, counter);
    counter += 1;
    stack.push(start);
    onStack.add(start);

    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const children = neighbors(frame.node);
      if (frame.next < children.length) {
        const child = children[frame.next]!;
        frame.next += 1;
        if (!index.has(child)) {
          index.set(child, counter);
          low.set(child, counter);
          counter += 1;
          stack.push(child);
          onStack.add(child);
          work.push({ node: child, next: 0 });
        } else if (onStack.has(child)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(child)!));
        }
      } else {
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1]!;
          low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
        }
        if (low.get(frame.node) === index.get(frame.node)) {
          const component: string[] = [];
          let current: string | undefined;
          do {
            current = stack.pop();
            if (current === undefined) break;
            onStack.delete(current);
            component.push(current);
          } while (current !== frame.node);
          component.sort();
          const selfLoop =
            component.length === 1 && neighbors(component[0]!).includes(component[0]!);
          if (component.length > 1 || selfLoop) cycles.push(component);
        }
      }
    }
  }
  return cycles;
}

export interface RelativeEscape {
  readonly file: string;
  readonly specifier: string;
  readonly targetPackage: string;
}

/**
 * Détecte les imports relatifs qui « s'échappent » d'un paquet vers un AUTRE
 * paquet du dépôt (ex. `../../provider-v86/src/...`). Ces chemins contournent
 * la surface publique et figent la structure interne.
 */
export function findCrossPackageRelativeImports(
  packages: readonly WorkspacePackage[],
): RelativeEscape[] {
  const escapes: RelativeEscape[] = [];
  for (const pkg of packages) {
    for (const file of collectSourceFiles(join(pkg.dir, 'src'))) {
      const source = readFileSync(file, 'utf8');
      for (const specifier of extractModuleSpecifiers(source)) {
        if (!specifier.startsWith('.')) continue;
        const resolved = resolve(dirname(file), specifier);
        for (const other of packages) {
          if (other.name === pkg.name) continue;
          const prefix = other.dir.endsWith(sep) ? other.dir : other.dir + sep;
          if (resolved === other.dir || resolved.startsWith(prefix)) {
            escapes.push({
              file: toPosix(relative(process.cwd(), file)),
              specifier,
              targetPackage: other.name,
            });
            break;
          }
        }
      }
    }
  }
  return escapes;
}
