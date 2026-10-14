# ADR 0001 — Exécution navigateur uniquement

- **Statut :** accepté
- **Date :** 2026-10-14
- **Contexte :** LumiBoot doit exécuter des systèmes directement dans le navigateur de l'utilisateur,
  avec des moteurs WebAssembly interchangeables.

## Décision

Toute exécution passe par une interface stable `VMProvider` (`canRun`, `start`) résolue par un
`VMRegistry`. Les moteurs sont chargés paresseusement et exécutent tout le calcul sur le CPU du
visiteur via WebAssembly.

L'UI ne connaît jamais `new V86(...)` : elle ne parle qu'à un `VMHandle`.

## Conséquences

- Le catalogue attribue explicitement un `engineId` et un `executionMode` à chaque système ;
  la compatibilité n'est jamais déduite d'un nom ou d'un numéro de version.
- Un moteur non intégré ne peut pas être « implicitement » compatible : le repli
  `UnavailableProvider` signale honnêtement l'indisponibilité.
- L'ajout futur d'un nouveau moteur WASM n'implique aucune réécriture des composants UI.
