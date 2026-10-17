# Architecture

## Vue d'ensemble

```text
React UI
  ├─ catalogue validé (@lumiboot/catalog + @lumiboot/contracts)
  └─ SessionLifecycle / VMRegistry (@lumiboot/vm-core)
       └─ V86Provider chargé à la demande
            ├─ assets et manifestes (@lumiboot/vm-assets)
            ├─ stockage local (@lumiboot/vm-storage)
            └─ profil réseau (@lumiboot/vm-network)
                 ├─ Fetch v86
                 ├─ proxy local WISP
                 └─ relais WISP utilisateur
```

La VM, son CPU et sa RAM s'exécutent dans le navigateur. Le proxy local et les relais WISP ne transportent que le réseau.

## Composants

| Chemin | Responsabilité |
|---|---|
| `apps/web` | React/Vite, catalogue, fiche système et écran de session |
| `apps/network-proxy` | binaire Go WISP V1 sur loopback |
| `packages/contracts` | types et schémas Zod partagés |
| `packages/catalog` | familles, images, profils, variantes et disponibilité |
| `packages/vm-core` | contrats moteur, registre et cycle de vie |
| `packages/provider-v86` | intégration v86, console, readiness et réseau |
| `packages/vm-assets` | manifestes, téléchargement, intégrité et disques locaux |
| `packages/vm-storage` | stockage versionné et quotas |
| `packages/vm-network` | modes, profils, capacités et diagnostics réseau |
| `images` | scripts et métadonnées de construction ; gros binaires ignorés |
| `infra` | Nginx, développement local et relais WISP optionnel |

## Garde-fous d'architecture

Les règles ci-dessous sont vérifiées automatiquement par
`tests/architecture.test.ts`, adossé à l'outil d'analyse de graphe
`tests/arch/dependency-graph.ts` (aucune dépendance externe). `pnpm test` les
exécute en local comme en CI : une violation échoue le build, elle n'est jamais
un simple avertissement.

### Frontières de paquets

Le sens des dépendances est figé dans `ALLOWED_INTERNAL_DEPS` :

```text
apps/web
  ├─ @lumiboot/catalog      → @lumiboot/contracts
  ├─ @lumiboot/vm-core      → @lumiboot/vm-network → @lumiboot/contracts
  ├─ @lumiboot/vm-assets    → @lumiboot/contracts
  └─ @lumiboot/provider-v86 → {contracts, vm-assets, vm-core, vm-network}
```

Règles appliquées :

- `@lumiboot/contracts` est une **feuille** : aucun `@lumiboot/*` ;
- un paquet ne dépend jamais d'un paquet hors de sa frontière, ni d'un
  `@lumiboot/*` non déclaré (pas de dépendance fantôme) ;
- aucun paquet ne dépend de `@lumiboot/web`, de React ou de Zustand ;
- aucun import profond `@lumiboot/<pkg>/…` ni chemin relatif traversant un autre
  paquet : la surface publique est `src/index.ts` ;
- ajouter un paquet impose de **déclarer explicitement** sa frontière (test
  « chaque paquet de l'espace de travail déclare ses frontières »).

### Cycles

Le graphe déclaré (`package.json`) **et** le graphe des imports réels sont
acycliques (détection Tarjan, `findCycles`). Un cycle est une régression de
conception : il doit être cassé, jamais toléré.

### Compatibilité runtime profil / `engineId`

- tout `engineId` de profil appartient au catalogue (`packages/catalog/src/engines.ts`) ;
- l'architecture du système est servie par le moteur du profil (table
  `ENGINE_ARCHITECTURES` du test) ;
- un système `ready` ne s'appuie que sur un moteur `integrated` ;
- `checkEngineCompatibility` accepte tout profil intégré lorsque WebAssembly est
  disponible, et le refuse sinon.

### Concurrence

Garanties vérifiées sur le vrai `SessionLifecycle`/`VMRegistry`, sans disque
propriétaire :

- deux `start()` concurrents ne créent qu'une seule instance (single-flight) ;
- deux sessions concurrentes restent isolées : aucun état partagé ;
- `dispose()` pendant un `start()` en vol libère l'instance, sans orpheline ;
- `register()` est idempotent pour un même moteur.

## Flux de lancement

1. Le catalogue construit et valide les `OSDefinition` depuis une image et un profil.
2. L'UI crée une session avec l'identifiant du système ou de la variante.
3. `VMRegistry` résout le moteur ; v86 est importé dynamiquement.
4. `V86Provider` vérifie le manifeste et construit l'émulateur avec la configuration du profil.
5. La session devient `running` après la preuve déclarée : marqueur série Debian ou première lecture disque en mode `disk-boot`.
6. L'arrêt libère le contrôleur réseau, l'émulateur, les listeners et la session.

États : `idle → preparing → downloading → booting → running → stopping → stopped`, avec `error` en cas d'échec.

## Catalogue et disponibilité

Le moteur appartient au profil, pas à l'image. La disponibilité est calculée, jamais saisie manuellement :

```text
imageRef présent
+ profil browser compatible
+ moteur intégré
+ validated = true
= ready
```

Les systèmes exigeant un média utilisateur ou un asset local manquant restent indisponibles au lancement. Les variantes sont décrites dans [`system-variants.md`](system-variants.md).

## Routes

| Route | Vue |
|---|---|
| `/` | catalogue |
| `/systems/:slug` | fiche et choix de variante |
| `/session/:id` | session locale |

Il n'existe pas de route Settings. La configuration globale est chargée depuis `apps/web/public/lumiboot.config.json`.

## État fonctionnel

- Moteur intégré : v86, x86 32 bits.
- Debian 12 : CLI, X11/Openbox et XFCE validés.
- Windows 7 : variantes Lite et Professionnel, disques RAW locaux lus par HTTP Range.
- Windows 10 x86 : boot réel prouvé en développement local (disque RAW opérateur servi en HTTP Range, carte `virtio-net` + pilote VirtIO NetKVM) ; voir [`windows-10.md`](windows-10.md).
- Windows 11, Ubuntu, Fedora, Mint et macOS : catalogue seulement, moteurs ou images absents.
- Réseau : `offline`, `browser-fetch`, `local-proxy`, `user-relay`; `local-network` prévu.

## Invariants

- Pas de VM distante, VNC/RDP ni API d'orchestration.
- Pas de gros disque ou média propriétaire dans Git.
- Pas de secret dans une variable `VITE_*` ou un JSON public.
- Pas de logique moteur dans les composants React.
- Pas d'état `ready`, `running` ou `connected` sans preuve correspondante.
- Pas de dépendance inter-paquets hors frontière autorisée, ni de cycle entre
  paquets (`tests/architecture.test.ts`).
- Un profil de lancement ne peut associer une architecture à un moteur qui ne la
  sert pas (`ENGINE_ARCHITECTURES`).
