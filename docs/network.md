# Réseau — LumiBoot

Le sous-système réseau vit dans `@lumiboot/vm-network`. Il décrit **comment** une machine virtuelle
accède (ou non) au réseau, indépendamment du **moteur d'exécution** et du **système invité**.

L'exécution reste **100 % locale dans le navigateur** : LumiBoot n'embarque **aucun backend de
virtualisation ni serveur réseau**. La carte réseau émulée et le transport d'accès Internet tournent
dans le contexte du visiteur. Voir [`adr/0005-network-universal.md`](adr/0005-network-universal.md).

## Objectifs

- Un **réseau commun à tous les OS et tous les moteurs**, décrit une seule fois.
- **Exécution locale** : la NIC émulée et le transport vivent dans le navigateur de l'utilisateur.
- **Aucun backend LumiBoot** : pas de passerelle, pas de proxy CORS, pas de relais public par défaut.
- **Extensible** Linux / Windows / macOS / Android et aux futurs moteurs (x86-64, ARM, PowerPC, mobile)
  sans modifier l'architecture réseau commune.
- Une **source unique de vérité** pour les profils, les capacités, la validation et les diagnostics.

## Séparation des responsabilités

Le réseau est découpé en quatre couches indépendantes. Selon le moteur et le système, elles sont
fournies par l'émulateur, par le noyau invité ou par le transport navigateur.

| Couche | Rôle | Aujourd'hui (v86) |
|---|---|---|
| **Carte réseau virtuelle (NIC)** | Fournit une interface réseau matérielle à l'invité. | v86 expose une carte émulée (`virtio` ou `ne2k`) via `net_device`. |
| **Réseau local** | Liaison locale entre NIC, switch et routeur virtuels (adressage, diffusion, passerelle). | Assuré par l'émulateur pour le mode `browser-fetch`/`user-relay` ; switch virtuel **prévu** pour `local-network`. |
| **Pile TCP-IP invitée** | Empilement réseau du système invité (DHCP, DNS, TCP, UDP, ICMP). | Pile réseau de l'OS invité (Debian par ex.). |
| **Transport d'accès Internet** | Chemin des trames vers l'extérieur du navigateur. | Backend `fetch` natif de v86 (`browser-fetch`) ou client WISP au-dessus de `wss://` (`user-relay`). |

> **Ne pas supposer Ethernet ou VirtIO partout.** Toutes les cibles n'exposent pas une NIC : un
> moteur orienté application peut n'offrir que des **abstractions de sockets**. L'architecture
> prévoit donc trois niveaux interchangeables — **port Ethernet**, **adresse IP**, ou
> **sockets** — choisis selon les capacités réelles du moteur.

## Modes

Un mode est décrit par un `NetworkModeInfo` (`modes.ts`) : `id`, `label`, `description`,
`availability` (`ready` ou `planned`), `requiresRestart` et `requiresConfiguration`. Les capacités
d'un mode sont dérivées par `capabilitiesForMode(mode)` (`capabilities.ts`).

| Mode | Statut | Ce que ça fait | Capacités clés | Restrictions |
|---|---|---|---|---|
| `offline` | **implémenté** | La machine invitée est totalement isolée ; aucune NIC n'est fournie. | Aucune (toutes `false`). | Aucun accès réseau (`fullInternet = false`). |
| `browser-fetch` | **implémenté** | Réseau émulé au-dessus du backend `fetch` natif de v86. | `http`, `https`, `dhcp`, `dns`, `tcp`, `udp` ; `fullInternet = false`. | **HTTP/HTTPS seulement**, selon le support du navigateur. **CORS s'applique aux destinations**. Pas d'accès réseau brut. **Internet complet NON garanti**. |
| `user-relay` | **implémenté** | Internet complet via un relais **WISP personnel** en `wss://` fourni et administré par l'utilisateur. | `fullInternet = true` (toutes les capacités, `cors = false`). | Relais **fourni par l'utilisateur** ; validation stricte (pas de userinfo, pas de `ws://` sauf localhost en dev). **Aucun relais public par défaut**. |
| `local-network` | **prévu** (non implémenté) | Accès au réseau local de la machine hôte. | Jeu `local-network` (sans Internet complet externe). | **Non implémenté** : le switch virtuel est absent. Le mode est **refusé au démarrage** (`NETWORK_UNSUPPORTED_MODE`). **Ne pas l'activer artificiellement**. |

### Capacités par mode

`capabilitiesForMode` renvoie un objet `NetworkCapabilities` figé. `cors = true` signifie que les
requêtes sont **soumises à CORS** (contrainte navigateur) ; `cors = false` signifie qu'aucune
contrainte CORS navigateur ne s'applique au transport utilisé.

| Mode | ethernet | ip | sockets | dhcp | dns | tcp | udp | icmp | http | https | cors | fullInternet |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `offline` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `browser-fetch` | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✗ |
| `user-relay` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ |
| `local-network` (prévu) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |

### Notes sur les modes

- **`offline`** : valeur par défaut (`defaultNetworkProfile`). Une VM non configurée n'a aucun réseau.
- **`browser-fetch`** : le backend `fetch` de v86 ne donne **pas** un accès réseau brut ; il s'appuie
  sur les API du navigateur. Un invité qui émet du TCP/UDP arbitraire hors du périmètre HTTP(S)
  autorisé par CORS ne fonctionnera pas.
- **`user-relay`** : v86 attend un relais WISP. LumiBoot valide des adresses `wss://` et convertit en
  `wisps://` (client WISP au-dessus de `wss://`) au moment de la traduction vers `net_device`. Le
  relais est **personnel** : LumiBoot n'en fournit et n'en active aucun.
- **`local-network`** : le mode est déclaré pour préparer le switch virtuel local, mais rien n'est
  branché. Le contrat réserve déjà `requiresRestart: true` et `requiresConfiguration: true`.

## Cycle de vie & fiabilité

- **Configuration avant démarrage** : le profil réseau est fixé **avant** la construction de
  l'émulateur. **Changer de mode exige un redémarrage** (recréation de la session) : aucun changement
  à chaud n'est pris en charge.
- **Annulation** : `start(signal?)` accepte un `AbortSignal`. Un signal déjà avorté échoue avec
  `NETWORK_ABORTED` ; le démarrage avorté déclenche un nettoyage best-effort du contrôleur.
- **Arrêt / destruction idempotents** : `stop()` puis `dispose()` peuvent être appelés plusieurs fois.
  `dispose()` retire tous les auditeurs (`subscribe`) et marque le contrôleur comme libéré.
- **Libération des ressources** : à l'arrêt/destruction, les écouteurs v86
  (`eth-transmit-end`, `eth-receive-end`, `net0-send`) sont détachés et le contrôleur réseau est
  libéré ; aucune WebSocket ni listener ne doit rester orphelin.
- **Isolation entre sessions** : **chaque session possède son propre contrôleur** (jamais partagé).
  Une session ne doit jamais affecter une autre VM.
- **Transports annulables, observables et détruits** : l'état est exposé par `snapshot()` et
  `subscribe(...)` (diagnostics `mode`, `status`, `txBytes`, `rxBytes`, `lastError`).
- **Garde-fous anti-saturation** : les compteurs de trafic sont **bornés** (`Number.MAX_SAFE_INTEGER`)
  et ignorent les deltas `NaN`, négatifs ou infinis ; les messages d'erreur sont **tronqués** à
  300 caractères.
- **Événements concurrents** : chaque auditeur est appelé sur un **cliché immuable** ; l'exception
  d'un auditeur n'interrompt jamais le contrôleur ni les autres auditeurs.
- **Anti-fuite de connexions** : un contrôleur libéré refuse tout nouvel abonnement et n'émet plus.

## Sécurité

- **CORS et politiques du navigateur respectés** : le mode `browser-fetch` ne contourne jamais CORS.
- **Jamais** désactiver la sécurité du navigateur, ni Mettre en place un **proxy CORS ouvert**.
- **Relais utilisateur** : seules les adresses `wss://` sont acceptées ; pas d'identifiants
  (userinfo), pas de fragment. `ws://` (non chiffré) n'est toléré que sur **localhost** et
  uniquement en développement (`allowInsecure`). **Aucun relais public par défaut**.
- **Pas de secrets en clair** : le profil ne transporte qu'un mode et, éventuellement, une URL de
  relais ; jamais d'identifiants.
- **Aucune ressource distante** : le sous-système réseau ne crée ni backend, ni service, ni point
  d'entrée d'orchestration.

## Architecture future (prévu — documenté, non implémenté)

Ces éléments sont **prévus** et ne sont pas réalisés aujourd'hui :

- **Switch virtuel local** (mode `local-network`) reliant les VM du navigateur au réseau de l'hôte.
- **Routeur virtuel**, **DHCP** et **DNS** intégrés au réseau local émulé.
- **Pile TCP-IP WASM** embarquée pour les moteurs qui n'exécutent pas de pile réseau invitée.
- **Communication entre plusieurs VM** d'un **même navigateur** (segment local partagé).

> **Avant d'écrire une pile personnalisée, étudier les implémentations existantes** — notamment
> **`tcpip.js`** et **`lwIP`** — pour leur couverture, leurs licences et leur adéquation au navigateur.

La compatibilité avec de **futurs moteurs x86-64 / ARM / PowerPC / mobile** doit être préservée
**sans changer l'architecture réseau commune** : un nouveau moteur se contente de fournir le niveau
approprié (Ethernet, IP ou sockets) et de consommer les modes existants.

## Validation

### À tester

- **Hors ligne** : aucune NIC, aucun accès réseau.
- **Init NIC VirtIO** : la carte émulée est bien instanciée et reconnue par le noyau invité.
- **DHCP** : obtention d'une adresse par l'invité.
- **DNS** : résolution de nom depuis l'invité.
- **Requêtes HTTP compatibles CORS** : un accès HTTP(S) autorisé aboutit ; un accès refusé par CORS
  échoue proprement.
- **Relais WISP configuré** : un relais `wss://` valide se connecte ; une adresse invalide est rejetée.
- **Annulation** : un `AbortSignal` interrompt le démarrage.
- **Redémarrage** : changer de mode exige et obtient une session recréée.
- **Destruction** : à l'arrêt, tous les écouteurs/WebSocket/ressources sont libérés.

### Réellement vérifié aujourd'hui

Vérifié par tests unitaires (`packages/vm-network`, `packages/provider-v86`) :

- Modes et capacités (`capabilitiesForMode`), dont `browser-fetch` (`fullInternet = false`) et
  `user-relay` (`fullInternet = true`).
- Profil : défaut hors ligne, rejet des clés inconnues, nettoyage de `relayUrl` hors `user-relay`.
- Validation des URL de relais : `wss://` accepté, `ws://`/`http(s)://` rejetés, userinfo et fragment
  rejetés, `ws://` localhost toléré uniquement via `allowInsecure`.
- Cycle de vie du contrôleur : `start`/`stop`/`dispose` idempotents, annulation, compteurs bornés et
  ignorés si invalides, troncature d'erreur, **indépendance de deux contrôleurs**.
- Traduction profil → `net_device` v86 et sélection de la NIC (`virtio` Linux, `ne2k` Windows).
- Branchement des diagnostics v86 → contrôleur et émission de l'événement de session `network`.

**Non vérifié** (end-to-end invité) : DHCP, DNS, requêtes HTTP réelles, init NIC dans un vrai noyau,
relais WISP réel. Ces points dépendent d'une image système construite, publiée et démarrée ; le test
de démarrage Debian réel est gardé par la variable `VM_E2E_ASSETS=1` (voir `AGENTS.md`).
