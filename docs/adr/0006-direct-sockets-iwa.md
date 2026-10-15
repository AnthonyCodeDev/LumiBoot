# ADR 0006 — Égress TCP/UDP brut via Direct Sockets (Isolated Web App)

- **Statut :** proposé — **non disponible aujourd'hui** (documenté, non implémenté)
- **Date :** 2026-10-15
- **Contexte :** les transports actuels de `@lumiboot/vm-network` plafonnent la connectivité
  réelle. Avec `v86@0.5.471`, `browser-fetch` ne fonctionne qu'en **HTTP (port 80)** : le backend
  `fetch` n'enregistre pas le TCP 443, donc **HTTPS et `apt` échouent**, et **CORS s'applique**
  (voir [`0005-network-universal.md`](0005-network-universal.md) et [`../network.md`](../network.md)).
  `user-relay` transporte le TCP (dont 443) **seulement** via un **vrai relais WISP personnel**,
  l'UDP reste **optionnel** et l'ICMP **non garanti**.

## Décision (proposée)

Étudier un transport futur, **`DirectSocketsEgress`**, s'appuyant sur l'**API Direct Sockets**
disponible uniquement dans une **Isolated Web App (IWA)** installée dans Chrome. Il permettrait un
**égress TCP/UDP brut** depuis le navigateur, **sans relais** et **sans backend LumiBoot**.

Points structurants :

- **Non annoncé comme disponible.** Ce mode n'existe **pas aujourd'hui** ; il est **prévu** et
  conditionné à la distribution IWA.
- **Un onglet ordinaire ne dispose pas d'API TCP/UDP brut.** Direct Sockets n'est **pas** exposé au
  contexte d'une page normale.
- **Une PWA ordinaire ne suffit pas.** Il faut une **IWA** (paquet **signé**, installé, avec la
  permission `direct-sockets` déclarée) — un simple service worker / manifeste PWA ne donne **aucun**
  accès socket.
- **Niveau egress uniquement.** Le transport vit au niveau **transport/egress** de
  `@lumiboot/vm-network`, **jamais dans `VMEngine`**. Les moteurs (v86, futurs) continuent de fournir
  une NIC ou des sockets ; ils ne connaissent pas Direct Sockets.
- **Adossement possible à une pile lwIP / `tcpip.js`.** L'invité émet des **trames Ethernet** ; pour
  les relier à des sockets TCP/UDP de l'API, il faut une **pile IP côté navigateur**. La pile
  embarquée (`lwIP`/`tcpip.js`, déjà citée dans `network.md`) est la piste naturelle — à évaluer
  (licences, couverture, sécurité) **avant** toute implémentation.

### Ce que ce mode ne résout pas

- **ICMP** : Direct Sockets expose TCP et UDP, **pas** de sockets IP bruts ; l'ICMP (`ping`) reste
  **non garanti**.
- **Sécurité/confiance** : l'égress part directement de l'IP de la machine de l'utilisateur (comme
  `browser-fetch`), sans relais intermédiaire. Aucun contournement CORS n'est introduit : Direct
  Sockets ne lit pas les réponses HTTP pour le compte d'une origine Web ordinaire.
- **Distribution** : le modèle IWA (installation, signature, politiques d'entreprise) est **plus
  lourd** qu'une application Web ; il ne remplace pas l'expérience onglet/PWA actuelle.

## Alternatives écartées

- **WebSocket ordinaire comme proxy TCP** : un WebSocket n'est **pas** un serveur WISP et n'offre pas
  de TCP brut ; cela ne remplace ni `user-relay` ni Direct Sockets.
- **PWA ordinaire** : insuffisante (pas d'API socket).
- **Proxy CORS ouvert / backend LumiBoot** : interdit par `adr/0003-remote-isolation.md`.
- **Application native auxiliaire** : hors du modèle navigateur-local de LumiBoot.

## Conséquences

- **Rien n'est implémenté** : cet ADR **propose** une direction et **ne promet aucune disponibilité**.
  Le code ne doit pas exposer de mode `direct-sockets` tant qu'il n'existe pas.
- Les niveaux de confiance de `network.md` restent la référence : « prévu » ≠ « disponible », et
  « supporté » ≠ « vérifié à l'exécution ».
- Toute implémentation future devra rester au niveau **transport/egress**, sans toucher `VMEngine`,
  et préserver l'architecture réseau commune (`adr/0005-network-universal.md`).
