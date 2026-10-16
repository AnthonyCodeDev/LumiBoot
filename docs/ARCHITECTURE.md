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

Les tests d'architecture interdisent à `contracts`, `catalog`, `vm-core` et `provider-v86` d'importer React, Zustand ou `apps/web`.

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
- Windows 10/11, Ubuntu, Fedora, Mint et macOS : catalogue seulement, moteurs ou images absents.
- Réseau : `offline`, `browser-fetch`, `local-proxy`, `user-relay`; `local-network` prévu.

## Invariants

- Pas de VM distante, VNC/RDP ni API d'orchestration.
- Pas de gros disque ou média propriétaire dans Git.
- Pas de secret dans une variable `VITE_*` ou un JSON public.
- Pas de logique moteur dans les composants React.
- Pas d'état `ready`, `running` ou `connected` sans preuve correspondante.
