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
  - `browser-fetch` — **implémenté** : réseau émulé au-dessus du backend `fetch` natif de v86. De fait
    **HTTP (port 80) uniquement** : le backend `fetch` de `v86@0.5.471` n'enregistre pas le TCP 443,
    donc **HTTPS échoue** ; **soumis à CORS** (hôtes sans `Access-Control-Allow-Origin` refusés) ;
    **sans Internet complet garanti**.
  - `user-relay` — **implémenté** : réseau émulé via un **relais WISP personnel** en `wss://` fourni
    par l'utilisateur, validation stricte, **aucun relais public par défaut**. Ne **garantit pas**
    Internet complet : TCP (dont 443) passe **seulement via un vrai relais WISP compatible v86**, UDP
    est **optionnel**, ICMP **non garanti**.
  - `local-network` — **prévu**, **non implémenté** : désigne un **réseau virtuel entre invités**, **pas**
    le LAN physique de l'hôte ; switch virtuel absent, le mode est refusé au démarrage et ne doit pas
    être activé artificiellement.
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

### Trois niveaux de confiance

Pour éviter toute promesse mensongère, l'ADR distingue explicitement :

- **Configuré** : le mode est sélectionné et le profil validé (`lumiboot.config.json` →
  `runtime.resolveNetworkProfile`). Cela ne prouve **rien** sur la connectivité.
- **Techniquement supporté** : capacités déclarées par `capabilitiesForMode(mode)`.
- **Réellement vérifié** : connectivité **constatée à l'exécution** par des sondes `dns`/`http`/
  `https`/`tcp`, jamais déduites des compteurs `txBytes`/`rxBytes`.

**`fullInternet` n'est jamais vrai par simple sélection de mode** : il vaut `false` pour tous les
modes et ne peut devenir vrai qu'après vérification à l'exécution.

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
- Les limitations restent **honnêtes et visibles** :
  - `browser-fetch` ne garantit pas Internet complet : en pratique **HTTP seul** (pas de HTTPS),
    **CORS appliqué** (p. ex. `security.debian.org` refusé, donc `apt` échoue).
  - `user-relay` ne garantit rien seul : TCP (dont 443) **si** le relais est un **vrai serveur WISP
    compatible v86**, **UDP optionnel**, **ICMP non garanti**, **aucun relais public par défaut**.
  - `local-network` n'est pas disponible (réseau **entre invités**, pas le LAN de l'hôte).
  - Les relais sont strictement fournis par l'utilisateur et deviennent l'**IP de sortie** de
    l'invité (confiance/confidentialité à la charge de l'utilisateur).
- Aucun mode ne promet « Internet complet » : seul un état **vérifié à l'exécution** peut l'attester,
  et la vérification automatique reste **prévue**.
- Le détail des modes, de la fiabilité, de la sécurité et de l'activation WISP est documenté dans
  [`../network.md`](../network.md). Un futur transport TCP/UDP brut (Isolated Web App) est étudié
  dans [`0006-direct-sockets-iwa.md`](0006-direct-sockets-iwa.md) (**non disponible aujourd'hui**).
