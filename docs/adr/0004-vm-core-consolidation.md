# ADR 0004 — Consolidation du cœur vm-core (P0)

- **Statut :** accepté
- **Date :** 2026-10-14
- **Contexte :** l'audit d'architecture recommande de renforcer le cœur avant d'ajouter des OS :
  contrats explicites, cycle de vie fiable, compatibilité centralisée, isolation stricte.

## Décision

`packages/vm-core` est réorganisé par responsabilité :

```text
src/
├── contracts/    VMEngine, VMInstance, VMConfiguration, VMCapabilities, VMEvents
├── lifecycle/    SessionState, SessionStateMachine, SessionLifecycle
├── registry/     VMRegistry
├── compatibility/ EngineCompatibility
├── errors/       VMError
└── providers/    UnavailableProvider
```

- **`VMEngine`** remplace `VMProvider` (alias de compatibilité conservé) et ajoute
  `capabilities()` + une `VMConfiguration` optionnelle au démarrage.
- **`VMInstance`** remplace `VMHandle` et porte désormais `systemId`.
- **`SessionLifecycle`** absorbe la logique auparavant située dans le front-end
  (`SessionController` supprimé) : démarrage sans double-instance, arrêt idempotent, `dispose()`
  garanti même après échec partiel.
- **`EngineCompatibility`** centralise la vérification moteur × système × environnement.
- Les événements (`VMEvents`) et les schémas restent la source unique de vérité dans
  `@lumiboot/contracts`.

## Isolation

Un test dédié (`tests/architecture.test.ts`) vérifie que `vm-core`, `provider-v86`,
`catalog` et `contracts` n'importent ni React, ni Zustand, ni `apps/web`.

## Conséquences

- Ajouter un moteur ou un OS ne nécessite aucune modification des pages React.
- Le catalogue est validé par Zod au chargement (`validateCatalog`) ; zod est donc embarqué côté
  client (~12 kB gzip), coût accepté pour garantir l'absence de manifeste invalide et préparer le
  chargement de manifestes distants (Lot 4).
- `vm-assets` et `vm-storage` sont désormais créés comme socle de fiabilité, mais leur
  intégration métier complète reste à brancher dans les lots suivants.
