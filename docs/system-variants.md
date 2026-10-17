# Variantes système

Une famille de variantes apparaît sous une seule carte. La fiche conserve le contenu de la variante mère et le sélecteur choisit uniquement le profil à lancer.

## Modèle

Les champs sont déclarés dans `packages/catalog/src/profiles.ts`, puis copiés dans `OSDefinition` :

| Champ | Rôle |
|---|---|
| `variantGroupId` | identifiant de la mère ; absent sur la mère |
| `variantName` | libellé court affiché dans le sélecteur |
| `variantOrder` | priorité croissante ; la plus petite valeur est sélectionnée par défaut |

Chaque variante garde sa propre image, son profil, sa readiness et sa disponibilité.

## Groupes actuels

| Groupe | Ordre |
|---|---|
| Debian (`debian-12-i386`) | XFCE, X11, CLI |
| Windows 7 (`windows-7-x86`) | Professionnel, Lite |
| Windows 10 (`windows-10-x86`) | 32 bits, 64 bits (non intégré) |

## Helpers

- `getDisplaySystems()` : mères et systèmes autonomes ;
- `getVariantGroup()` : membres triés par `variantOrder` ;
- `getDefaultVariant()` : premier membre du groupe ;
- `getVariantParent()` / `getVariantParentId()` : résolution de la mère ;
- `hasVariants()` : groupe de plusieurs entrées.

Pour ajouter une variante : créer son image dans `images.ts`, son profil complet dans `profiles.ts`, renseigner `variantGroupId`, `variantName` et `variantOrder`, puis ajouter les tests catalogue/UI/E2E. Aucun changement de composant React n'est requis.
