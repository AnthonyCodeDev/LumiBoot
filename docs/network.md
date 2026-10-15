# Réseau — LumiBoot

Le sous-système réseau vit dans `@lumiboot/vm-network`. Il décrit **comment** une machine virtuelle
accède (ou non) au réseau, indépendamment du **moteur d'exécution** et du **système invité**.

L'exécution reste **100 % locale dans le navigateur** : LumiBoot n'embarque **aucun backend de
virtualisation ni serveur réseau**. La carte réseau émulée et le transport d'accès Internet tournent
dans le contexte du visiteur. Voir [`adr/0005-network-universal.md`](adr/0005-network-universal.md).

> **Aucun mode ne garantit « Internet complet » par simple sélection.** Choisir `user-relay` ne
> prouve rien : il faut un **vrai** relais WISP compatible v86 et une connectivité **vérifiée à
> l'exécution**. La connectivité réellement observée avec `v86@0.5.471` est limitée (voir
> [Connectivité effective](#connectivité-effective-v8605471)).

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

## Trois niveaux de confiance (ne jamais les confondre)

Une promesse réseau n'a de sens que rattachée à l'un de ces trois niveaux. **Un niveau supérieur
n'implique jamais le suivant.**

| Niveau | Définition | Source de vérité | Exemple |
|---|---|---|---|
| **Configuré** | Le mode a été sélectionné et le profil accepté (schéma valide). | `lumiboot.config.json` → `runtime.resolveNetworkProfile(systemId)` | `{ "mode": "user-relay", "relayUrl": "wss://…" }` |
| **Techniquement supporté** | Ce que le transport / la NIC / la pile invitée peuvent faire *par conception*. | `capabilitiesForMode(mode)` (`capabilities.ts`) | `fetch` : `cors = true` |
| **Réellement vérifié** | La connectivité a été **constatée à l'exécution** par des sondes. | diagnostics de session (`status`, `verified`) | `curl -I https://deb.debian.org/` réussit *depuis l'invité* |

Règles associées :

- **`fullInternet` n'est jamais vrai par simple sélection de mode.** Il vaut `false` pour tous les
  modes (`capabilitiesForMode(...).fullInternet === false`) ; il ne peut devenir vrai qu'après
  **vérification à l'exécution**.
- **Ne jamais déduire la connectivité des compteurs `txBytes`/`rxBytes`.** Un contrôleur peut
  transmettre des octets sans qu'aucune destination soit réellement joignable. Les compteurs
  mesurent le **trafic**, pas la **joignabilité**.
- La vérification s'appuie sur des **sondes runtime** `dns` / `http` / `https` / `tcp`. Le
  contrôleur ne passe à `status = "online"` que si le transport le rapporte explicitement
  (`setStatus('online')`) ; l'acceptation du profil ne donne que `configured`.
- **Sondes automatiques « prévu »** : aujourd'hui la vérification se fait **manuellement** depuis
  l'invité (voir [Activer Internet étendu](#activer-internet-étendu-wisp) et
  [Validation](#validation)). L'exécution automatique de ces sondes n'est **pas implémentée**.

## Modes

Un mode est décrit par un `NetworkModeInfo` (`modes.ts`) : `id`, `label`, `description`,
`availability` (`ready` ou `planned`), `requiresRestart` et `requiresConfiguration`. Les capacités
d'un mode sont dérivées par `capabilitiesForMode(mode)` (`capabilities.ts`).

| Mode | Statut | Ce que ça fait | Restrictions |
|---|---|---|---|
| `offline` | **implémenté** | La machine invitée est totalement isolée ; aucune NIC n'est fournie. | Aucun accès réseau (`fullInternet = false`). |
| `browser-fetch` | **implémenté** | Réseau émulé au-dessus du backend `fetch` natif de v86. | De fait **HTTP (port 80) uniquement** ; **HTTPS (443) ne fonctionne pas** avec v86 0.5.471. **CORS s'applique**. Pas d'accès brut. **Internet complet NON garanti**. |
| `local-proxy` | **implémenté** | Réseau émulé via le **LumiBoot Network Proxy** installé localement : relais **WISP local** sur loopback (`ws://127.0.0.1:37892/wisp/`). | Relais **local** (pas d'IP de sortie distante) mais **appairage explicite requis** ; UDP **non supporté par le client v86 actuel**, ICMP non garanti. **Internet complet NON garanti** (`fullInternet = false` par défaut, preuve par sonde). Voir [Proxy réseau local](#proxy-réseau-local). |
| `user-relay` | **implémenté** | Réseau émulé via un relais **WISP personnel** en `wss://` fourni et administré par l'utilisateur. | Ne **garantit rien** seul : dépend d'un **vrai serveur WISP** ; UDP optionnel ; ICMP non garanti. Relais **fourni par l'utilisateur**. **Aucun relais public par défaut**. |
| `local-network` | **prévu** (non implémenté) | **Réseau virtuel entre invités** (segment local partagé), **pas** le LAN physique de l'hôte. | **Non implémenté** : le switch virtuel est absent. Le mode est **refusé au démarrage** (`NETWORK_UNSUPPORTED_MODE`). **Ne pas l'activer artificiellement**. |

### Capacités déclarées par `capabilitiesForMode`

Le tableau ci-dessous décrit ce que le package **déclare** (niveau *techniquement supporté*).
`cors = true` signifie que les requêtes sont **soumises à CORS** (contrainte navigateur) ;
`cors = false` signifie qu'aucune contrainte CORS navigateur ne s'applique au transport utilisé.

| Mode | ethernet | ip | dhcp | dns | tcp | udp | icmp | transport | http | https | cors | fullInternet |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `offline` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | `none` | ✗ | ✗ | ✗ | ✗ |
| `browser-fetch` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | `fetch` | ✓ | ✓ | ✓ | ✗ |
| `local-proxy` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | `wisp` | ✓ | ✓ | ✗ | ✗ |
| `user-relay` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | `wisp` | ✓ | ✓ | ✗ | ✗ |
| `local-network` (prévu) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | `none` | ✗ | ✗ | ✗ | ✗ |

> Les cases `transport.https = ✓` décrivent la **classe de transport** (un `fetch` sait, en théorie,
> viser HTTPS). Elles **ne garantissent pas** que le backend v86 enregistre le HTTPS : c'est
> exactement ce que corrige le tableau suivant.

### Connectivité effective (v86@0.5.471)

Ce tableau décrit ce qui est **réellement opérationnel** avec le moteur actuel. C'est le niveau
*techniquement supporté mis à l'épreuve du réel*.

| Cible | `offline` | `browser-fetch` | `local-proxy` (proxy réseau local) | `user-relay` (relais WISP valide) |
|---|---|---|---|---|
| DHCP / DNS invité | ✗ | ✓ | ✓ | ✓ |
| HTTP (port 80) | ✗ | ✓ (si CORS autorise l'origine) | ✓ | ✓ |
| HTTPS (port 443) | ✗ | **✗** | ✓ | ✓ |
| TCP arbitraire | ✗ | ✗ | ✓ | ✓ |
| UDP | ✗ | ✗ | **✗** (client v86 actuel ; refusé proprement par le proxy réseau local) | **optionnel** (dépend du relais) |
| ICMP (`ping`) | ✗ | ✗ | **non garanti** | **non garanti** |
| Internet complet garanti | ✗ | ✗ | **✗** | **✗** |

- **Pourquoi HTTPS échoue en `browser-fetch`** : le backend `fetch` de `v86@0.5.471` n'enregistre
  le TCP que pour le **port 80**. Aucune connexion TCP vers 443 n'est établie, donc pas de TLS ; le
  HTTPS est impossible, et par conséquent `apt` (qui interroge les dépôts en HTTPS/HTTP) échoue.
- **CORS** : en `browser-fetch`, toute requête reste **soumise à CORS**. Un hôte qui n'envoie pas
  `Access-Control-Allow-Origin` est **refusé** par le navigateur, p. ex. `security.debian.org` :
  `apt update` échoue alors. Aucun contournement (proxy CORS) n'est prévu — voir `adr/0003`.

### Notes sur les modes

- **`offline`** : valeur par défaut (`defaultNetworkProfile`). Une VM non configurée n'a aucun réseau.
- **`browser-fetch`** : le backend `fetch` de v86 ne donne **pas** un accès réseau brut ; il s'appuie
  sur les API du navigateur et n'enregistre le TCP que pour le **port 80**. Un invité qui émet du
  TCP/UDP arbitraire, ou du HTTPS, ne fonctionnera pas.
- **`user-relay`** : v86 attend un relais **WISP**. LumiBoot valide des adresses `wss://` et convertit
  en `wisps://` (client WISP au-dessus de `wss://`) au moment de la traduction vers `net_device`. Un
  **WebSocket ordinaire n'est pas** forcément un serveur WISP : seul un **vrai relais WISP compatible
  v86** transporte le TCP (dont 443). Le relais est **personnel** — LumiBoot n'en fournit et n'en
  active aucun. Le relais devient l'**IP de sortie** vers Internet (voir [Sécurité](#sécurité)).
- **`local-proxy`** : même transport WISP que `user-relay`, mais le relais est le **proxy réseau local
  local** (`ws://127.0.0.1:37892/wisp/`, loopback, appairage explicite approuvé par l'utilisateur).
  Le trafic TCP sort par **la propre connexion de l'utilisateur** (aucune IP de sortie distante),
  sans contrainte CORS navigateur. `fullInternet` reste `false` par défaut (preuve par sonde).
  Voir [Proxy réseau local](#proxy-réseau-local).
- **`local-network`** : désigne un **réseau virtuel entre invités** d'un même navigateur, **et non**
  le LAN physique de l'hôte. Le mode est déclaré (`requiresRestart: true`,
  `requiresConfiguration: true`) mais rien n'est branché ; le switch virtuel est absent.

## Configuration

La configuration est **globale** ; **il n'existe pas de page Settings**, tout passe par
`apps/web/public/lumiboot.config.json`, chargé au démarrage puis exposé par
`runtime.resolveNetworkProfile(systemId)` (`apps/web/src/config/runtime.ts`).

- `network.defaultProfile` : profil réseau par défaut de toute session.
- `network.systems[systemId]` : profil spécifique d'un système ; **prioritaire** sur le défaut.
- Le profil est validé par Zod (`networkProfileSchema`) ; `relayUrl` n'est conservé qu'en
  `user-relay`.

```json
{
  "version": 1,
  "network": {
    "defaultProfile": { "mode": "browser-fetch" },
    "systems": { "debian-12-i386": { "mode": "browser-fetch" } }
  }
}
```

Le fichier livré reste en `browser-fetch` tant qu'aucun relais n'est fourni.

## Activer Internet étendu (WISP)

Pour dépasser les limites de `browser-fetch` (HTTP seul, CORS), il faut un **relais WISP personnel**.
**Un relais public inconnu ne doit pas être utilisé.**

### Prérequis

- Un **vrai serveur WISP compatible v86 0.5.471** et son URL `wss://` (TLS). LumiBoot **n'en fournit
  aucun** ; un simple WebSocket ne suffit pas.
- L'URL doit être un `wss://` sans identifiants (userinfo) ni fragment ; `ws://` n'est toléré que
  sur `localhost` en développement (`allowInsecure`).

### Étapes côté déploiement

1. **Éditer** `apps/web/public/lumiboot.config.json` pour le profil global et/ou un système :

   ```json
   {
     "version": 1,
     "network": {
       "defaultProfile": { "mode": "user-relay", "relayUrl": "wss://relay.example.org/wisp" },
       "systems": {
         "debian-12-i386": { "mode": "user-relay", "relayUrl": "wss://relay.example.org/wisp" }
       }
     }
   }
   ```

   `network.systems[systemId]` est prioritaire, sinon `network.defaultProfile` s'applique.
2. **Remplacer** l'URL par celle d'un **relais WISP réel et de confiance** (jamais un relais public
   inconnu). **Ne mettre aucun secret dans ce JSON** : il est **public** (servi tel quel).
3. **Redémarrer la session** : le profil est fixé **avant** la construction de l'émulateur ; changer
   de mode exige une **nouvelle session** (`requiresRestart`).
4. **Vérifier l'ouverture du WebSocket** : dans DevTools (onglet Réseau / Console), confirmer que la
   WebSocket `wss://…` s'ouvre bien vers le relais.
5. **Tester depuis l'invité** (console série) :

   ```bash
   ip -br addr                     # NIC et adresse obtenues
   getent hosts deb.debian.org     # DNS
   curl -I https://deb.debian.org/ # HTTPS (443) à travers le relais
   sudo apt update                 # usage réel de bout en bout
   ```

   Ces commandes constituent les **sondes runtime** dns/http/https/tcp du niveau *réellement
   vérifié*. Un succès de `curl`/`apt` est une preuve ; des compteurs `txBytes`/`rxBytes` non nuls
   n'en sont pas une.

### Rappels

- **Pas de secret** dans `lumiboot.config.json` : il est public.
- **Ne pas utiliser de relais public inconnu.** Préférer un relais que vous administrez.
- Le relais est l'**IP de sortie** vers Internet : tout le trafic de l'invité sort par lui. La
  confidentialité et la confiance dépendent donc **entièrement** de l'opérateur du relais.

## Proxy réseau local

Alternative au relais distant : le **LumiBoot Network Proxy** (`apps/network-proxy/`,
binaire Go natif Windows/macOS/Linux) expose un **serveur WISP V1 sur loopback**
(`127.0.0.1:37892`). En mode `local-proxy`, l'invité s'y relie après **appairage
explicite** approuvé par l'utilisateur (Origin vérifiée + token de session en query, car
v86 0.5.471 n'envoie ni sous-protocole ni en-tête). Destinations sensibles bloquées après
résolution DNS, quotas et révocation : le modèle complet est décrit dans
[`network-proxy.md`](network-proxy.md), décision
[`adr/0007-network-proxy.md`](adr/0007-network-proxy.md). `fullInternet` reste
`false` par défaut : la connectivité se prouve par sonde depuis l'invité, comme pour
`user-relay`.

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
  `subscribe(...)` (diagnostics `mode`, `status`, `transport`, `verified`, `txBytes`, `rxBytes`,
  `lastError`).
- **Garde-fous anti-saturation** : les compteurs de trafic sont **bornés** (`Number.MAX_SAFE_INTEGER`)
  et ignorent les deltas `NaN`, négatifs ou infinis ; les messages d'erreur sont **tronqués** à
  300 caractères.
- **Événements concurrents** : chaque auditeur est appelé sur un **cliché immuable** ; l'exception
  d'un auditeur n'interrompt jamais le contrôleur ni les autres auditeurs.
- **Anti-fuite de connexions** : un contrôleur libéré refuse tout nouvel abonnement et n'émet plus.

## Sécurité

- **CORS et politiques du navigateur respectés** : le mode `browser-fetch` ne contourne jamais CORS.
- **Jamais** désactiver la sécurité du navigateur, ni mettre en place un **proxy CORS ouvert**.
- **Relais utilisateur** : seules les adresses `wss://` sont acceptées ; pas d'identifiants
  (userinfo), pas de fragment. `ws://` (non chiffré) n'est toléré que sur **localhost** et
  uniquement en développement (`allowInsecure`). **Aucun relais public par défaut**.
- **Confiance du relais** : en `user-relay`, le relais voit le trafic IP de l'invité et devient son
  **IP de sortie** vers Internet. Utiliser un relais **que l'on administre ou en qui l'on a
  confiance** ; ne jamais saisir de secret en clair dans l'invité.
- **Pas de secrets en clair** : le profil ne transporte qu'un mode et, éventuellement, une URL de
  relais ; jamais d'identifiants. Le fichier `lumiboot.config.json` est **public**.
- **Aucune ressource distante** : le sous-système réseau ne crée ni backend, ni service, ni point
  d'entrée d'orchestration.

## Architecture future (prévu — documenté, non implémenté)

Ces éléments sont **prévus** et ne sont pas réalisés aujourd'hui :

- **Switch virtuel local** (mode `local-network`) : **réseau virtuel entre invités** d'un même
  navigateur (segment local partagé), **pas** le LAN physique de l'hôte.
- **Routeur virtuel**, **DHCP** et **DNS** intégrés au réseau local émulé.
- **Pile TCP-IP WASM** embarquée pour les moteurs qui n'exécutent pas de pile réseau invitée.
- **Communication entre plusieurs VM** d'un **même navigateur** (segment local partagé).
- **Sondes de vérification automatiques** (`dns`/`http`/`https`/`tcp`) alimentant `status`/`verified`.
- **`DirectSocketsEgress`** : transport futur pour une version **Isolated Web App** (accès
  TCP/UDP brut via Direct Sockets), **non disponible aujourd'hui** — voir
  [`adr/0006-direct-sockets-iwa.md`](adr/0006-direct-sockets-iwa.md). **Un onglet ordinaire ne
  dispose pas** d'API TCP/UDP brut, et une PWA ordinaire ne suffit **pas**.

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
- **HTTP en `browser-fetch`** : un accès HTTP (port 80) autorisé par CORS aboutit ; un accès refusé
  par CORS échoue proprement ; le **HTTPS échoue** (limite connue).
- **Relais WISP configuré** : un relais `wss://` **valide et compatible v86** se connecte et
  transporte le TCP 443 ; une adresse invalide est rejetée.
- **Annulation** : un `AbortSignal` interrompt le démarrage.
- **Redémarrage** : changer de mode exige et obtient une session recréée.
- **Destruction** : à l'arrêt, tous les écouteurs/WebSocket/ressources sont libérés.

### Tests d'intégration (Playwright)

Deux suites couvrent le réseau depuis un **invité réel** (Debian 12 i386 sous
v86). Elles sont **gardées** : sans image, elles sont **ignorées** (skipped), pas
« réussies ».

| Variable d'environnement | Rôle |
|---|---|
| `VM_E2E_ASSETS=1` | Active les deux suites : l'image Debian doit être publiée. |
| `LUMIBOOT_WISP_RELAY_URL` | Relais WISP **de test** (`wss://…`), fourni **uniquement** par l'environnement. Active la suite `network-wisp`. **Jamais** codé en dur, ni en CI. |

```powershell
# Boot réel + sondes `browser-fetch` (HTTP oui, HTTPS/apt non) + cycle de vie.
$env:VM_E2E_ASSETS='1'; pnpm test:e2e

# Suite WISP opt-in (nécessite un vrai relais WISP TLS compatible v86).
$env:LUMIBOOT_WISP_RELAY_URL='wss://relay.example.org/wisp'
$env:VM_E2E_ASSETS='1'; pnpm test:e2e --grep "WISP"
```

- `tests/e2e/network-debian.spec.ts` : mode `browser-fetch`. Vérifie `enp0s10`
  UP + adresse `192.168.x`, route par défaut, résolution DNS, **HTTP réussi**,
  **HTTPS en échec** et **`apt-get update` en échec** — les limites v86/CORS
  sont des assertions, pas des contournements. Vérifie aussi qu'un relais
  **injoignable** (`wss://127.0.0.1:9/`) n'empêche ni le démarrage ni
  Arrêter/Redémarrer.
- `tests/e2e/network-wisp.spec.ts` : `user-relay`. Réécrit temporairement
  `apps/web/public/lumiboot.config.json` puis le **restaure** dans `afterAll`
  (même en cas d'échec). Exige DHCP/DNS, puis **HTTPS réussi** et
  `apt-get update` **réussi**.

> La suite WISP modifie un fichier de configuration **global** : lancez-la
> isolément (`--grep "WISP"`, idéalement `--workers=1`) pour ne pas interférer
> avec les autres specs exécutées en parallèle.

### Réellement vérifié aujourd'hui

Vérifié par tests unitaires (`packages/vm-network`, `packages/provider-v86`) :

- Modes et capacités (`capabilitiesForMode`) : `fullInternet = false` pour **tous** les modes ;
  `udp`/`icmp = false` pour `browser-fetch` et `user-relay`.
- Profil : défaut hors ligne, rejet des clés inconnues, nettoyage de `relayUrl` hors `user-relay`.
- Validation des URL de relais : `wss://` accepté, `ws://`/`http(s)://` rejetés, userinfo et fragment
  rejetés, `ws://` localhost toléré uniquement via `allowInsecure`.
- Cycle de vie du contrôleur : `start`/`stop`/`dispose` idempotents, annulation, compteurs bornés et
  ignorés si invalides, troncature d'erreur, **indépendance de deux contrôleurs** ; `status` reste
  `configured` après `start()` et `verified` n'est vrai qu'après `setStatus('online')`.
- Traduction profil → `net_device` v86 (`fetch`, `wisps://`) et sélection de la NIC (`virtio` Linux,
  `ne2k` Windows).
- Branchement des diagnostics v86 → contrôleur et émission de l'événement de session `network`.

**Non vérifié** (end-to-end invité) : DHCP, DNS, requêtes HTTP réelles, init NIC dans un vrai noyau,
relais WISP réel, et **détection automatique** de la joignabilité. Ces points dépendent d'une image
système construite, publiée et démarrée ; le test de démarrage Debian réel est gardé par la variable
`VM_E2E_ASSETS=1` (voir `AGENTS.md`). La vérification manuelle (dns/http/https/tcp) se fait depuis
l'invité, comme décrit dans [Activer Internet étendu](#activer-internet-étendu-wisp).
