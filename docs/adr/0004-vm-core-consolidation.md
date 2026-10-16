# ADR 0004 — Cœur `vm-core`

- Statut : accepté
- Date : 2026-10-14

## Décision

`@lumiboot/vm-core` sépare cinq responsabilités :

- `contracts/` : `VMEngine`, `VMInstance`, configuration, capacités et événements ;
- `lifecycle/` : états et transitions d'une session ;
- `registry/` : résolution du moteur ;
- `compatibility/` : validation moteur × système × navigateur ;
- `errors/` et `providers/` : erreurs normalisées et moteur indisponible.

`SessionLifecycle` garantit une seule instance, un arrêt idempotent et l'appel de `dispose()` après arrêt ou échec partiel. `tests/architecture.test.ts` interdit les dépendances React/Zustand dans les packages métier.

## Conséquences

- L'ajout d'un système passe par le catalogue, pas par des conditions dans l'UI.
- Les contrats et schémas Zod sont centralisés dans `@lumiboot/contracts`.
- `vm-assets`, `vm-storage` et `vm-network` restent indépendants du frontend.
