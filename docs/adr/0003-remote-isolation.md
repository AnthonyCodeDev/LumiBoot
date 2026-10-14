# ADR 0003 — Sans infrastructure distante

- **Statut :** accepté
- **Date :** 2026-10-14

## Contexte

Le projet a été clarifié autour d'une architecture purement locale. Toute tentative de conserver un
cadre de VM distante, des workers externes ou une API d'orchestration créerait de la complexité,
une surface d'attaque et des divergences avec le modèle navigateur-first.

## Décision

- Les moteurs sont chargés dynamiquement dans le navigateur au moment du lancement.
- Le cycle de vie garantit `stop()` puis `dispose()` sans laisser de ressource orpheline.
- Les données persistent via IndexedDB et OPFS, avec quotas et validation.
- Aucun service de console, aucun proxy API et aucun système de VM distant ne sont ajoutés au dépôt.

## Conséquences

- L'application reste portable, simple à déployer et conforme à la stratégie locale exclusive.
- Les secrets, points d'entrée réseau et ressources d'orchestration ne doivent pas être ajoutés au codebase ou au dépôt.
- Les évolutions futures doivent s'inscrire dans un modèle navigateur-local, sans réintroduire la logique distante.
