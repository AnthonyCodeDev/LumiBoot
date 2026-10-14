# LumiBoot

Bibliothèque et lanceur de **systèmes d'exploitation dans le navigateur**, inspiré des launchers de
jeux et des services de cloud gaming. Interface unique, **plusieurs moteurs d'exécution
interchangeables**.

> **État : intégration v86 (Lot 1) implémentée.** Le moteur v86 est réellement branché derrière
> `VMProvider` (WASM, BIOS, disque lu par HTTP Range, console VGA/série, marqueur `ttyS0`),
> le cycle de vie gère arrêt/redémarrage/annulation, le manifeste d'image est validé par un
> schéma Zod strict. Aucun bouton ne simule une machine virtuelle. Il reste à **construire et
> publier l'image Debian 12 i386** (`images/debian-12-i386/build.sh`) puis à passer Debian à
> `ready` après le smoke test réel dans le navigateur.

## Démarrage

```bash
pnpm install
pnpm assets:prepare   # copie v86.wasm + BIOS dans apps/web/public/v86/
pnpm dev              # http://127.0.0.1:5173
```

Les binaires du moteur (`v86.wasm`, `seabios.bin`, `vgabios.bin`) sont préparés par
`scripts/prepare-v86-assets.mjs` (version et SHA verrouillés dans
`scripts/v86-assets.lock.json`) ; `pnpm assets:check` vérifie leur intégrité.

Autres commandes :

```bash
pnpm build          # typecheck + build de production (apps/web/dist)
pnpm typecheck      # vérification TypeScript stricte de tous les packages
pnpm lint           # ESLint
pnpm test           # tests unitaires + composants (Vitest)
pnpm test:e2e       # tests de bout en bout (Playwright, nécessite un navigateur)
```

### Référence HTML/CSS/JS d'origine

La référence statique est conservée dans `prototype/` et reste exécutable sans dépendances :

```bash
cd prototype
py -m http.server 5173
# ou : python -m http.server 5173
```

## Architecture

```text
apps/web                 React + TypeScript + Vite (catalogue, fiches, sessions)
packages/contracts       Schémas Zod et types partagés
packages/catalog         Systèmes, moteurs, capacités, filtrage (source de vérité)
packages/vm-core         Cœur : contrats (VMEngine, VMInstance, VMCapabilities…), cycle de vie,
                         registre, compatibilité, repli honnête
packages/vm-assets       Manifestes, téléchargement, cache et intégrité SHA-256 des images
packages/vm-storage      Stockage persistant versionné, quotas et export/import
packages/provider-v86    Moteur v86 réel : WASM, BIOS, disque HTTP Range, console VGA/série
images/debian-12-i386    Script de build Debian + manifeste (image à construire puis publier)
infra                    Docker Compose, Nginx, notes de déploiement local
docs                     Brief, architecture, ADR, sécurité, licences
prototype                Référence statique d'origine (référence visuelle)
```

### Principe clé

L'UI ne connaît **jamais** `new V86(...)` : elle parle à un `VMEngine` résolu par le `VMRegistry`.
Le cycle de vie (démarrage, arrêt, destruction) est centralisé dans `SessionLifecycle` ; le
front-end ne fait que refléter l'état. Un moteur absent ou non intégré est signalé **honnêtement**
par le `UnavailableProvider` — jamais par une progression simulée.

Voir [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/AGENT_BRIEF.md`](docs/AGENT_BRIEF.md) et
les ADR dans [`docs/adr/`](docs/adr/).

## Contrats

- **Catalogue** typé et validé par Zod au chargement (`validateCatalog`) : `id`, famille, version,
  architecture, `engineId`, `executionMode`, `availability`, pré-requis, licence… Un manifeste
  invalide ou dupliqué fait échouer immédiatement l'application.
- **`VMEngine`** : `id`, `capabilities()`, `canRun(os)`, `start(os, mountTarget, configuration?)`.
- **`SessionLifecycle`** : démarrage sans double-instance, arrêt idempotent, `dispose()` garanti.
- **`EngineCompatibility`** : vérifie qu'un moteur peut lancer un système sur l'appareil courant.
- États normalisés : `idle → preparing → downloading → booting → running → stopping → stopped`,
  plus `error`. La transition `booting → running` exige une preuve de démarrage réel.
- **Isolation vérifiée par test** : `vm-core`, les moteurs et le catalogue n'importent ni React, ni
  Zustand, ni le front-end (`tests/architecture.test.ts`).

## Ce qui reste à faire

1. **P1 — Fiabilité** : `packages/vm-assets` (téléchargement, progression, annulation, reprise,
   SHA-256, cache, requêtes HTTP Range) et `packages/vm-storage` (stockage persistant versionné,
   quotas, export/import, backend mémoire et navigateur).
2. **Lot 1 — Debian 12 i386 réel via v86** : le code est en place ; il reste à construire l'image
   (`images/debian-12-i386/build.sh`), la publier (`apps/web/public/images/debian-12-i386/`),
   exécuter le smoke test (`VM_E2E_ASSETS=1 pnpm test:e2e`), puis passer Debian à
   `availability:'ready'` **et** `engines.v86.integrated` à `true`.
3. **Lot 2 — Persistance** : snapshots de disque vs RAM/CPU, continuité après refresh.
4. **Lot 3 — Autres moteurs locaux** : deuxième Linux et Windows historique, sans modifier le cœur ni l'UI.
5. **Lot 4 — Extension navigateur** : moteurs WASM additionnels, toujours sans backend de virtualisation.

## Avertissements

- Windows 10/11 64 bits et les macOS récents **ne sont pas encore pris en charge** par les moteurs
  locaux actuels.
- Les licences Microsoft et Apple doivent être respectées. Ne jamais intégrer ni redistribuer
  d'images de systèmes propriétaires sans autorisation (voir [`docs/LICENSES.md`](docs/LICENSES.md)).

## Documentation

- [`docs/AGENT_BRIEF.md`](docs/AGENT_BRIEF.md) — pitch, périmètre, lots, critères d'acceptation
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — arborescence cible, contrats, sécurité
- [`docs/SECURITY.md`](docs/SECURITY.md) — règles de sécurité
- [`docs/LICENSES.md`](docs/LICENSES.md) — licences et gestion des images
