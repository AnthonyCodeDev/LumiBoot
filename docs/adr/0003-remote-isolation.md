# ADR 0003 — Isolation locale des moteurs WASM

- **Statut :** accepté
- **Date :** 2026-10-14

## Contexte

Les moteurs d'émulation doivent rester chargés à la demande, isolés du rendu React et capables de
libérer leurs ressources sans fuite.

## Décision

- Les moteurs sont chargés dynamiquement dans le navigateur au moment du lancement.
- Le cycle de vie garantit `stop()` puis `dispose()` sans laisser de ressource orpheline.
- Le stockage des données persistantes passe par IndexedDB et OPFS, avec quotas et validation.

## Conséquences

- Isolation des moteurs par modules chargés à la demande et contrats stricts.
- Gestion explicite des quotas, de l'annulation et des erreurs de chargement.
- Les secrets et l'état persistant restent côté navigateur, jamais dans un backend de calcul.
