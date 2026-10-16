# Groupes de variantes système

Un **groupe de variantes** permet de présenter plusieurs déclinaisons d'un même système
d'exploitation (console, bureau, flavour…) derrière **une seule carte** dans la bibliothèque,
la variante se choisissant ensuite depuis la fiche système.

## Modèle

Chaque système reste une `OSDefinition` complète (une image + un profil de lancement). Un
groupe est décrit par **deux champs optionnels** portés par le profil de lancement et recopiés
dans l'`OSDefinition` par `packages/catalog/src/systems.ts` :

| Champ | Rôle |
|---|---|
| `variantGroupId` | Id de la **mère** du groupe. **Absent** sur la mère elle-même (et sur tout système autonome). |
| `variantName` | **Spécificité** de la variante. Le dropdown de la fiche affiche le libellé « nom de base + spécificité » (ex. « Debian XFCE », « Debian X11 », « Debian CLI »). Le libellé « Variante » n'est **pas** affiché. |
| `variantOrder` | Ordre de préférence **croissant** au sein du groupe. La plus petite valeur = **meilleure variante** (première, sélectionnée/ouverte par défaut). |

Règles :

- La **mère** n'a pas de `variantGroupId` ; elle peut porter un `variantName`.
- Un **enfant** porte `variantGroupId` = id de la mère, plus son `variantName`.
- `variantOrder` est optionnel : les membres sans valeur passent en dernier, à égalité l'ordre
  du catalogue est conservé (tri stable).
- Les identifiants et slugs existants ne changent jamais (stabilité des liens et des tests).
- La disponibilité reste **dérivée** image par image / profil par profil : chaque variante a sa
  propre `availability`.

État actuel du catalogue :

- Groupe Debian — ordre/défaut = **XFCE** (`variantOrder: 1`) :
  - `debian-12-i386-xfce` (`variantGroupId: 'debian-12-i386'`, `variantName: 'XFCE'`, `variantOrder: 1`) — **meilleure variante**, ouverte par défaut.
  - `debian-12-i386-desktop` (`variantGroupId: 'debian-12-i386'`, `variantName: 'X11'`, `variantOrder: 2`)
  - `debian-12-i386` (mère/ancre, `variantName: 'CLI'`, `variantOrder: 3`)
- Groupe **Windows 7** — ordre/défaut = **Professionnel** (`variantOrder: 1`) :
  - `windows-7-pro-sp1-x86` (`variantGroupId: 'windows-7-x86'`, `variantName: 'Professionnel'`, `variantOrder: 1`) — **meilleure variante**, ouverte par défaut ; disque RAW 32 Gio, `validated: true`.
  - `windows-7-x86` (mère/ancre, `displayName: 'Windows 7'`, `variantName: 'Lite'`, `variantOrder: 2`) ; disque RAW 16 Gio, `validated: true` (boot bureau réel prouvé, `tests/e2e/windows7-desktop.spec.ts`).
  - La carte catalogue « Windows 7 » ouvre la mère neutre ; le dropdown propose « Windows 7 Professionnel » et « Windows 7 Lite ».
- Tous les autres systèmes (Ubuntu, Windows 10/11, macOS…) sont **autonomes** (aucune variante).
- Windows 7 suit désormais **exactement le même modèle que Debian** : une carte, une mère neutre, un dropdown de variantes, et un choix qui ne change que la variante lancée (voir `docs/windows-7.md`).

## Helpers du catalogue

Exportés par `@lumiboot/catalog` (voir `packages/catalog/src/systems.ts`) :

- `getDisplaySystems(): OSDefinition[]` — mères de groupe + systèmes autonomes, **sans** les
  enfants ;
- `getVariantGroup(system): OSDefinition[]` — tous les membres du groupe **triés par
  `variantOrder` croissant** (meilleure variante en premier), `[system]` si aucune mère trouvée ;
- `getDefaultVariant(system): OSDefinition` — la **meilleure variante** du groupe (première de
  `getVariantGroup`), ou le système lui-même s'il est autonome. Utilisé par la fiche pour
  présélectionner la variante à lancer ;
- `getVariantParent(system): OSDefinition` — la mère d'un enfant (ou le système lui-même) ;
- `getVariantParentId(system): string` — l'id de la mère effective ;
- `hasVariants(system): boolean` — vrai si le groupe compte plus d'une entrée.

## Comportement UI

- **Grille** (`apps/web/src/features/catalog/catalog.selectors.ts`) : le filtre
  (`filterSystems`) tourne d'abord sur le catalogue **plat** (la recherche matche donc aussi les
  enfants), puis chaque résultat est replié vers sa mère en dédupliquant. Résultat : une seule
  carte par groupe. Au clic, la carte ouvre **la mère/base**
  (`navigate('/systems/${target.slug}')`, `SystemGrid.tsx`) : la variante se choisit ensuite sur
  la fiche.
- **Fiche** (`apps/web/src/pages/SystemPage.tsx`) : le **contenu affiché** (hero, description,
  spec-box, pré-requis, intégration, licences, accent) est **toujours** celui de la mère/base
  (`getVariantParent(system)`) — le « Debian de base ». Le dropdown de variante ne change donc
  **jamais** le contenu de la page. Si `getVariantGroup(base).length > 1`, un **dropdown custom**
  (`apps/web/src/components/catalog/VariantDropdown.tsx`, classes `.variant-dropdown*`) s'affiche
  juste à gauche du bouton « Lancer une session ». Il affiche le libellé « nom de base +
  spécificité » de la variante sélectionnée (en blanc) + un chevron — le libellé « Variante » n'est
  **pas** affiché (porté uniquement par `aria-label="Choisir la variante"`). Le menu est un
  `role="listbox"` de boutons `role="option"` ; **choisir une option ne navigue PAS et ne modifie
  pas le contenu** : seul le libellé du dropdown change, et la variante retenue est celle qui sera
  **lancée**. À l'ouverture
  de la fiche, la sélection vaut la **meilleure variante** (`getDefaultVariant(base)`) ; un lien
  direct vers un slug d'enfant présélectionne cet enfant. Le bouton « Lancer une session » crée la
  session de la **variante sélectionnée** (`createSession(selected.id)`) et la readiness est
  évaluée sur cette variante (`getLaunchReadiness(selected)`).

## Ajouter un nouveau groupe (exemple : Ubuntu)

1. **Images** — `packages/catalog/src/images.ts` : créer une image par variante
   (`SystemImageDefinition`), avec un `id` unique, le bon `familyId`, `architecture`,
   `imageRef` **uniquement si l'image est réellement construite**, `requirements` et
   `integrationNote`. Ne jamais déclarer de disponibilité ici.

   ```ts
   {
     id: 'ubuntu-24-i386-image',
     familyId: 'ubuntu',
     architecture: 'i386',
     imageRef: 'ubuntu-24-i386',
     requirements: ['Navigateur moderne', 'WebAssembly', 'Mémoire suffisante'],
     integrationNote: 'Base console Ubuntu 24 i386 sous v86.',
   },
   ```

2. **Profils** — `packages/catalog/src/profiles.ts` : créer un `LaunchProfileDefinition` par
   variante. La **première** variante est la **mère** : elle ne porte **pas** de
   `variantGroupId` (mais un `variantName`). Les suivantes portent
   `variantGroupId: '<id de la mère>'` et leur `variantName`.

   ```ts
   // Mère
   {
     id: 'ubuntu-24-i386',
     imageId: 'ubuntu-24-i386-image',
     engineId: 'v86',
     executionMode: 'browser',
     minMemoryMiB: 256,
     configuration: { memoryMiB: 1024, vgaMemoryMiB: 16, bootDevice: 'cdrom' },
     hardwareProfile: pcHardware('virtio'),
     readiness: guestReadiness('ubuntu-24-i386'),
     slug: 'ubuntu-24-i386',
     displayName: 'Ubuntu',
     versionLabel: '24.04 LTS',
     validated: false,
   variantName: 'CLI',
      variantOrder: 3,
      description: '…',
    },
    // Enfant
   {
     // …même famille de champs…
     id: 'ubuntu-24-i386-desktop',
     imageId: 'ubuntu-24-i386-desktop-image',
     slug: 'ubuntu-24-i386-desktop',
      displayName: 'Ubuntu (Bureau)',
      variantName: 'Bureau',
      variantGroupId: 'ubuntu-24-i386',
      variantOrder: 1,
      validated: false,
    }
    ```

3. **Rien d'autre** : `systems.ts` recopie `variantGroupId`/`variantName`/`variantOrder` dans
   l'`OSDefinition`, et l'UI (grille + fiche) s'adapte automatiquement. La variante au plus petit
   `variantOrder` devient la meilleure (ouverte par défaut, en tête du dropdown). Ne pas modifier
   `packages/contracts`.

## Ajouter un enfant à un système existant (exemple : nouvelle variante du groupe Windows 7)

Le groupe Windows 7 est déjà implémenté (mère `windows-7-x86`). Pour lui ajouter
une variante supplémentaire :

1. **Image** — `images.ts` : ajouter `windows-7-ultimate-x86-image` (même `familyId: 'windows'`,
   `architecture: 'i386'`, `mediaStrategy: 'user-import'` si le média n'est pas distribuable,
   `licenseNotes` le cas échéant).
2. **Profil** — `profiles.ts` : ajouter le profil enfant en pointant vers la **mère existante** :

   ```ts
   {
     id: 'windows-7-ultimate-x86',
     imageId: 'windows-7-ultimate-x86-image',
     engineId: 'v86',
     executionMode: 'browser',
     minMemoryMiB: 1536,
     configuration: { memoryMiB: 1536, vgaMemoryMiB: 16, bootDevice: 'disk' },
     hardwareProfile: { ...pcHardware('ne2k'), acpi: true },
     readiness: diskBootReadiness('windows-7-ultimate-x86'),
     slug: 'windows-7-ultimate-x86',
     displayName: 'Windows 7 (Ultimate)',
     versionLabel: 'Ultimate · x86',
     validated: false,
     // Rattachement à la mère existante du groupe Windows 7.
     variantGroupId: 'windows-7-x86',
     variantName: 'Ultimate',
     variantOrder: 3,
     description: '…',
   }
   ```

3. La fiche Windows 7 propose alors le dropdown enrichi ; `getVariantGroup(windows7)` renvoie
   `[Professionnel, Lite, Ultimate]` trié par `variantOrder`. La carte ouvre toujours la mère et le
   dropdown présélectionne la variante par défaut (au plus petit `variantOrder`).

## Tests

- `packages/catalog/src/variants.test.ts` — helpers du catalogue (groupes Debian **et Windows 7**).
- `apps/web/src/components/catalog/SystemGrid.test.tsx` — repliement de la grille.
- `apps/web/src/pages/SystemPage.test.tsx` — présence et comportement du dropdown de variante
  (contenu de la mère, défaut = meilleure variante, sélection sans navigation, Échap).
- `tests/e2e/catalog.spec.ts` — une seule carte Debian et comptage global.
- `tests/e2e/xfce-debian.spec.ts` / `tests/e2e/desktop-debian.spec.ts` — la carte Debian ouvre la
  mère ; XFCE est lancée directement (défaut), le flavor Bureau bascule vers X11 via le dropdown
  sans changement d'URL.
- `tests/e2e/windows7-desktop.spec.ts` — la carte Windows 7 ouvre la mère ; Professionnel est lancée
  directement (défaut), et Lite se sélectionne dans le dropdown (`VM_E2E_ASSETS=1`).
