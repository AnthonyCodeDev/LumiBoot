# LumiBoot

Bibliothèque et lanceur de **systèmes d'exploitation dans le navigateur**, inspiré des launchers de
jeux et des services de cloud gaming. Interface unique, **plusieurs moteurs d'exécution
interchangeables**.

> **État : Debian 12 i386 démarre réellement dans le navigateur.** L'image réelle (noyau
> `vmlinuz-686`, `initrd`, disque ext4) est publiée dans `apps/web/public/images/debian-12-i386/`, la
> console VGA/série et le clavier FR fonctionnent, et le boot est prouvé par un test E2E réel
> (`tests/e2e/session-debian.spec.ts`, gardé par `VM_E2E_ASSETS=1`). Le moteur v86 est branché
> derrière `VMProvider` (WASM, BIOS, disque lu par HTTP Range, marqueur `ttyS0`) ; le cycle de vie
> gère arrêt/redémarrage/annulation et les manifestes d'image/catalogue sont validés par Zod. La
> disponibilité est **dérivée de faits** (image présente, moteur intégré, boot validé) : Debian 12
> i386 est donc `ready`. Aucun bouton ne simule une machine virtuelle.

## Démarrage

```bash
pnpm install
pnpm assets:prepare   # copie v86.wasm + BIOS dans apps/web/public/v86/
pnpm dev              # http://127.0.0.1:5173
```

Les binaires du moteur (`v86.wasm`, `seabios.bin`, `vgabios.bin`) sont préparés par
`scripts/prepare-v86-assets.mjs` (version et SHA verrouillés dans
`scripts/v86-assets.lock.json`) ; `pnpm assets:check` vérifie leur intégrité.

L'image Debian (plusieurs gigaoctets) n'est pas versionnée : la construire puis la publier dans
`apps/web/public/images/debian-12-i386/` — voir `images/debian-12-i386/README.md`.

Autres commandes :

```bash
pnpm build          # typecheck + build de production (apps/web/dist)
pnpm typecheck      # vérification TypeScript stricte de tous les packages
pnpm lint           # ESLint
pnpm format:check   # vérifie le formatage Prettier (pnpm format pour corriger)
pnpm test           # tests unitaires + composants (Vitest)
pnpm test:e2e       # E2E Playwright sur le port 5200 (jamais 5173, réservé au dev)
```

Le boot Debian E2E n'est exécuté que si les artefacts sont publiés :
`VM_E2E_ASSETS=1 pnpm test:e2e`.

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
apps/web/src/config      Chargement de la configuration globale, avant le rendu React
apps/web/public/lumiboot.config.json   Configuration réseau globale publique
packages/contracts       Schémas Zod et types partagés
packages/catalog         Systèmes, moteurs, capacités, filtrage (source de vérité)
packages/vm-core         Cœur : contrats (VMEngine, VMInstance, VMCapabilities…), cycle de vie,
                         registre, compatibilité, repli honnête
packages/vm-assets       Manifestes, téléchargement, cache et intégrité SHA-256 des images
packages/vm-storage      Stockage persistant versionné, quotas et export/import
packages/vm-network      Réseau commun agnostique (modes, capacités, profil, cycle de vie, diagnostics)
packages/provider-v86    Moteur v86 réel : WASM, BIOS, disque HTTP Range, console VGA/série
images/debian-12-i386    Script de build Debian + manifeste (image publiée dans apps/web/public)
infra                    Docker Compose, Nginx, notes de déploiement local
prototype                Référence statique d'origine (référence visuelle)
```

### Principe clé

L'UI ne connaît **jamais** `new V86(...)` : elle parle à un `VMEngine` résolu par le `VMRegistry`.
Le cycle de vie (démarrage, arrêt, destruction) est centralisé dans `SessionLifecycle` ; le
front-end ne fait que refléter l'état. Un moteur absent ou non intégré est signalé **honnêtement**
par le `UnavailableProvider` — jamais par une progression simulée.

### Configuration réseau globale

Le réglage réseau n'est pas éditable dans l'application : la configuration est **globale** et chargée
au démarrage **avant le rendu React** (`apps/web/src/main.tsx` →
`apps/web/src/config/load-config.ts`), à partir de `apps/web/public/lumiboot.config.json` (schéma Zod
strict, version 1). Un échec de chargement affiche un message lisible plutôt qu'une application
démarrée sans configuration. Ce réglage ne passe ni par Zustand, ni par `localStorage`. Le profil
effectif d'un système est `network.systems[id]` s'il existe, sinon `network.defaultProfile`. Détails
et modes : `docs/network.md`.

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

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — arborescence cible, contrats, routes UI
- [`docs/network.md`](docs/network.md) — réseau commun : modes, capacités, diagnostics
- [`docs/AGENT_BRIEF.md`](docs/AGENT_BRIEF.md) — brief produit et technique, lots, critères d'acceptation
- [`docs/SECURITY.md`](docs/SECURITY.md) — règles de sécurité
- [`docs/LICENSES.md`](docs/LICENSES.md) — licences et gestion des images
- [`docs/adr/0005-network-universal.md`](docs/adr/0005-network-universal.md) — ADR « réseau
  universel » (les autres décisions vivent dans `docs/adr/`)

## Ce qui reste à faire

1. **P1 — Fiabilité** : `packages/vm-assets` résout déjà les manifestes d'image (utilisé par
   `provider-v86`) ; il reste à brancher le téléchargement avec progression/reprise et le cache
   persistant. `packages/vm-storage` (stockage persistant versionné, quotas, export/import, backend
   mémoire et navigateur) n'est pas encore branché dans l'application.
2. **Réseau — validation invitée et réseau local** : le socle `@lumiboot/vm-network` est en place
   (modes `offline`, `browser-fetch` et `user-relay` implémentés, `local-network` prévu). Il reste à
   valider le réseau réel de l'invité (DHCP, DNS, HTTP compatible CORS, relais WISP) et à implémenter
   `local-network` (switch virtuel), toujours sans backend réseau LumiBoot — voir `docs/network.md`.
3. **Lot 2 — Persistance** : snapshots de disque vs RAM/CPU, continuité après refresh.
4. **Lot 3 — Autres moteurs locaux** : deuxième Linux et Windows historique, sans modifier le cœur ni
   l'UI.
5. **Lot 4 — Extension navigateur** : moteurs WASM additionnels, toujours sans backend de
   virtualisation.
