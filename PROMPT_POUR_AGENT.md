# Première instruction à coller dans ton agent IA

Tu vas développer **LumiBoot**, une plateforme Web de lancement de systèmes d'exploitation sous forme de bibliothèque visuelle inspirée des launchers de jeux. Je te fournis le dépôt `lumiboot/`. Avant de coder, lis **intégralement** `docs/AGENT_BRIEF.md`, `docs/ARCHITECTURE.md` et la référence `prototype/`.

## Objectif de ce premier ticket

1. Préparer une **architecture monorepo professionnelle** avec `pnpm workspaces`, React + TypeScript + Vite, séparation `apps/` et `packages/`, linting, tests et conventions.
2. **Migrer fidèlement le design et les interactions** de la référence HTML/CSS/JS fournie vers des composants React réutilisables. Ne refais pas le design à ta convenance.
3. Définir le catalogue d'OS typé, les schémas partagés, l'interface `VMProvider` et une state machine de session.
4. Préparer un `V86Provider` isolé, avec chargement paresseux et interfaces testables, mais **ne pas simuler** le lancement de Debian.
5. Concevoir clairement une exécution **browser uniquement** : Debian 12 i386 local via v86 en premier, puis d'autres moteurs WASM locaux pour les autres architectures quand ils seront prêts.
6. Fournir un rapport de changements, les commandes pour installer/démarrer/tester, les limites et un plan précis du ticket suivant **« Démarrer Debian 12 i386 réellement via v86 »**.

## Contraintes impératives

- N'annonce pas qu'un OS fonctionne tant que tu n'as pas réellement démarré le système et vérifié une commande Linux.
- Ne télécharge pas d'images de Windows/macOS depuis des sources non autorisées et ne les ajoute pas à Git.
- Évite la sur-ingénierie : backend Fastify, PostgreSQL, worker QEMU et agent Mac sont seulement la **cible future**, pas un prérequis du MVP local.
- Ne mélange pas moteur v86 et rendu React dans un même composant.
- TypeScript strict, composants accessibles, tests Vitest/Playwright, responsive.
- Garde une interface élégante, sobre, sombre et la navigation clavier fonctionnelle.
- Demande confirmation avant tout changement majeur d'architecture non prévu dans les documents.

**Critère de succès immédiat :** la nouvelle app React reproduit la page existante, son catalogue est data-driven, recherche/favoris/fiche fonctionnent, et le code est prêt pour une intégration réelle de Debian sans dette de conception structurelle.
