# ADR 0005 — Réseau universel dans `@lumiboot/vm-network`

- **Statut :** accepté
- **Date :** 2026-10-14
- **Contexte :** LumiBoot doit donner accès au réseau à terme à plusieurs OS (Linux, Windows, macOS,
  Android) exécutés par plusieurs moteurs (v86 aujourd'hui, d'autres ensuite : x86-64, ARM, PowerPC,
  mobile). L'accès réseau ne doit pas être réimplémenté dans chaque moteur, ni dépendre d'un backend
  de virtualisation ou d'un serveur réseau LumiBoot : l'exécution reste locale dans le navigateur.

## Décision

Un package dédié, **`@lumiboot/vm-network`**, décrit un **réseau commun agnostique du moteur**, dans
lequel le moteur branche ses capacités. Il est **local-first** : aucune ressource distante LumiBoot.

Le réseau est séparé en quatre responsabilités indépendantes :

- **Carte réseau virtuelle (NIC)** : port Ethernet fourni à l'invité (`virtio`/`ne2k` pour v86).
- **Réseau local** : liaison locale, adressage et passerelle entre NIC et transport.
- **Pile TCP-IP invitée** : empilement réseau du système invité.
- **Transport d'accès Internet** : chemin des trames vers l'extérieur (navigateur ou relais).

Selon le moteur, ces responsabilités peuvent être exposées comme **port Ethernet**, **adresse IP** ou
**abstractions de sockets** ; l'architecture ne suppose donc pas Ethernet/VirtIO partout.

Le package fournit :

- **Modes** (`modes.ts`) :
  - `offline` — **implémenté** : isolation totale.
  - `browser-fetch` — **implémenté** : réseau émulé au-dessus du backend `fetch` natif de v86 ;
    soumis à CORS, **sans Internet complet garanti**.
  - `user-relay` — **implémenté** : Internet complet via un **relais WISP personnel** en `wss://`
    fourni par l'utilisateur, validation stricte, **aucun relais public par défaut**.
  - `local-network` — **prévu**, **non implémenté** : switch virtuel local absent ; le mode est refusé
    au démarrage et ne doit pas être activé artificiellement.
- **Capacités** (`capabilities.ts`) dérivées par `capabilitiesForMode(mode)`.
- **Profil** (`profile.ts`) validé par Zod, conservant `relayUrl` uniquement en `user-relay`, défaut
  `offline`.
- **Validation de relais** (`relay.ts`) : `wss://` seul, `ws://` localhost toléré en développement.
- **Contrôleur de cycle de vie et diagnostics** (`controller.ts`, `diagnostics.ts`), avec état
  observable, annulation, arrêt/destruction idempotents et compteurs bornés.
- **Erreurs normalisées** (`errors.ts`).

Côté moteur, un adaptateur (`provider-v86/src/network/V86NetworkAdapter.ts`) traduit le profil en
`net_device` v86 : backend `fetch` en `browser-fetch`, relais WISP `wisps://` en `user-relay`, aucune
NIC en `offline`.

## Alternatives écartées

- **Réseau implémenté moteur par moteur** : duplique la logique, empêche l'UI et les diagnostics
  communs, et fait diverger les règles de sécurité.
- **Relais public LumiBoot par défaut** : introduirait un backend et un proxy CORS ouvert, contraires
  aux ADR 0001 et 0003 (local exclusif, sans infrastructure distante).
- **Activer `local-network` sans switch virtuel** : donnerait une fausse impression de connectivité ;
  le mode reste explicitement `planned` et refusé.

## Conséquences

- Ajouter un OS ou un moteur ne nécessite **aucune** modification de l'architecture réseau commune.
- La configuration réseau est **fixée avant le démarrage** ; changer de mode **exige un redémarrage**
  de la session. Chaque session possède **son propre** contrôleur (aucune interférence entre VM).
- L'UI peut afficher les **mêmes** capacités et diagnostics quel que soit le moteur, sans supposer
  Ethernet.
- Les limitations restent **honnêtes et visibles** : `browser-fetch` ne garantit pas Internet complet,
  `local-network` n'est pas disponible, et les relais sont strictement fournis par l'utilisateur.
- Le détail des modes, de la fiabilité et de la sécurité est documenté dans
  [`../network.md`](../network.md).
