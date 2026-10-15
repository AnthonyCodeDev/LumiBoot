# Contrat web ↔ proxy réseau local (LumiBoot Network Proxy)

Ce document décrit, **en prose exploitable comme spécification** (machine-readable),
l'API HTTP/WebSocket exposée par le **LumiBoot Network Proxy**
(`apps/network-proxy/`) et les invariants que le frontend
(`packages/vm-network`, `apps/web/src/features/proxy/`) peut tenir pour acquis.

Il fait autorité côté contrat ; l'implémentation de référence est
`apps/network-proxy/internal/server/server.go` (routes) et
`apps/network-proxy/internal/auth/auth.go` (appairage/sessions). Contexte et
décision : [`network-proxy.md`](network-proxy.md) et
[`adr/0007-network-proxy.md`](adr/0007-network-proxy.md).

- **Base URL** : `http://127.0.0.1:37892` par défaut (loopback **strict**,
  `DEFAULT_PROXY_URL` dans `packages/vm-network/src/proxy.ts`). WebSocket dérivée
  en `ws://…/wisp/`.
- **Transport** : HTTP/1.1, `Content-Type: application/json; charset=utf-8` pour
  les corps JSON. Corps de requête borné à **64 Kio** (`maxBody`), champs
  inconnus **rejetés** (`DisallowUnknownFields`).
- **Toutes les réponses** portent les en-têtes de sécurité du proxy :
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`,
  `Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`.

## 0. Invariants transverses

- **Origin liée** : l'en-tête `Origin` est normalisé (`scheme://host[:port]`,
  minuscules, sans chemin ni slash final — `auth.NormalizeOrigin`) puis comparé
  **par match exact** à l'allow-list du proxy. Une origine absente est **refusée**
  sur les endpoints sensibles (le provider tourne toujours dans un navigateur,
  qui envoie `Origin`). Le port compte : une origine de dev `http://localhost:5200`
  doit figurer dans la configuration du proxy.
- **CORS jamais `*`** : sur une origine autorisée, la réponse reflète l'origine
  exacte dans `Access-Control-Allow-Origin` et ajoute `Vary: Origin`. Sur une
  origine refusée, **aucun** en-tête CORS d'autorisation n'est émis.
- **Préflight** : toute requête `OPTIONS` est court-circuitée **avant** le routeur.
  Origine autorisée → `204 No Content` avec
  `Access-Control-Allow-Methods: GET, POST, OPTIONS`,
  `Access-Control-Allow-Headers: Content-Type`,
  `Access-Control-Max-Age: 600`. Origine refusée → `403` JSON.
- **Jamais de secret journalisé** : les logs internes censurent tout `token=…`
  (`redactingWriter`).
- **`/health` ne prouve RIEN** sur l'authentification : il répond même sans
  jeton ni origine autorisée. Un état « connecté » côté web EXIGE en plus une
  **vérification authentifiée** (`GET /api/session/verify`, §4.5). Voir §7.

Forme d'erreur JSON uniforme (`writeError`) :

```json
{ "error": "<message en français>" }
```

## 1. `GET /health`

Sonde de disponibilité et de version. **Aucune** authentification, **aucune**
origine requise (mais CORS reflété si l'origine est autorisée).

- **200 OK** :

```json
{
  "status": "ok",
  "version": "1.0.0",
  "wispVersion": 1,
  "uptimeSeconds": 42,
  "activeConnections": 3,
  "counters": { "...": "compteurs de diagnostics" }
}
```

- `version` : version du binaire (surchargée à la compilation via
  `-ldflags -X …/internal/server.Version`).
- `wispVersion` : version de protocole WISP supportée. **Toujours `1`
  aujourd'hui** (`const WispVersion = 1`).
- `uptimeSeconds` : entier, secondes depuis le démarrage.
- `activeConnections` : connexions TCP actives (entier).
- `counters` : instantané des compteurs (diagnostics).

## 2. Appairage

L'approbation (`approve`/`deny`) se fait **uniquement depuis la console du
proxy** (terminal), jamais depuis le web.

### 2.1 `POST /api/pair/request`

Crée une demande d'appairage. L'origine est lue dans l'en-tête `Origin` ; si
l'en-tête est absent, un corps `{ "origin": "…" }` est accepté en repli.

- **Corps** : `{}` **ou** `{ "origin": string }` (facultatif).
- **201 Created** :

```json
{ "pairingId": "…", "userCode": "123456", "expiresAt": "2026-10-15T12:34:56Z" }
```

  - `userCode` : 6 chiffres, affiché à l'utilisateur pour approbation console.
  - `expiresAt` : RFC 3339 UTC. TTL d'appairage (10 min par défaut).
- **400 Bad Request** : corps JSON invalide.
- **403 Forbidden** : origine absente ou non autorisée.
- **429 Too Many Requests** : trop de demandes en attente (plafonds
  anti-flood : 64 au total, 8 par origine).

### 2.2 `GET /api/pair/status?id=<pairingId>`

- **200 OK** : `{ "status": "pending" | "approved" | "denied", "expiresAt": "<RFC3339>" }`.
- **403 Forbidden** : origine non autorisée.
- **404 Not Found** : appairage inconnu ou expiré.

### 2.3 `POST /api/pair/exchange`

Échange un appairage **approuvé** contre un **token de session à usage unique**.
La requête doit porter la **même** origine que celle de l'appairage.

- **Corps** : `{ "pairingId": string }`.
- **200 OK** : `{ "token": "<base64url>", "expiresAt": "<RFC3339>" }`.
  - `token` : 32 octets aléatoires, base64url. **Renvoyé une seule fois** ;
    stocké côté proxy uniquement sous forme **hachée SHA-256**. L'appairage est
    consommé (usage unique).
- **400 Bad Request** : corps JSON invalide.
- **403 Forbidden** : origine non autorisée, **ou** échange impossible
  (appairage inconnu, expiré, non approuvé, ou origine différente). Le proxy ne
  distingue pas ces cas (même code, message unique).

### 2.4 `POST /api/session/revoke`

Révocation par **possession du token brut**. **Aucune** origine requise
(auto-révocation) ; CORS reflété si l'origine est autorisée.

- **Corps** : `{ "token": string }`.
- **200 OK** : `{ "revoked": true }` (le transport WebSocket associé est fermé).
- **404 Not Found** : session introuvable (déjà expirée/révoquée, ou token vide).

### 2.5 `GET /api/session/verify?token=<token>`

**Vérification authentifiée** : contrôle **origine + token** sans upgrade
WebSocket. C'est la **seule** preuve exploitable d'un état « connecté » côté web
(§7). Requête CORS simple (pas d'en-tête personnalisé), token en query comme
`/wisp/`.

- **200 OK** : `{ "ok": true, "expiresAt": "<RFC3339>" }`.
- **401 Unauthorized** : token invalide ou expiré.
- **403 Forbidden** : origine non autorisée.

## 3. `GET /wisp/` (et `GET /wisp`) — session WISP V1

Point d'accès WebSocket WISP. Le token transite **en query string** car v86
0.5.471 n'envoie **ni sous-protocole ni en-tête** :

```
ws://127.0.0.1:37892/wisp/?token=<token>
```

- **Origin obligatoire** et autorisée ; sinon **403** JSON (`origine non autorisée`),
  sans upgrade.
- **Token obligatoire et valide** pour cette origine ; sinon **403** JSON
  (`token de session invalide ou expiré`), sans upgrade.
- Après upgrade, la session est **enregistrée atomiquement** auprès de
  l'authentificateur : révocation, expiration ou arrêt du serveur **ferment
  réellement** la WebSocket et les connexions TCP associées.
- **Protocole** : WISP V1, cadrage `[type:u8][stream_id:u32 LE][payload]`.
  - `CONNECT` (`0x01`) : **TCP uniquement** ; UDP refusé proprement (`0x41`).
  - `DATA`, `CONTINUE` (fenêtre initiale émise dès le handshake, exigée par v86),
    `CLOSE`.
  - `INFO` (`0x05`, V2) : **ignoré** (le proxy est V1 strict).
- **Sous-protocole** : aucun n'est requis ni négocié (`Sec-WebSocket-Protocol`
  non utilisé).

## 4. Codes d'erreur — récapitulatif

| Code | Signification | Endpoints |
|---|---|---|
| **400** | Corps JSON invalide (ou champ inconnu) | `/api/pair/request`, `/api/pair/exchange`, `/api/session/revoke` |
| **401** | Token invalide ou expiré | `/api/session/verify` |
| **403** | Origine non autorisée ; échange impossible ; token invalide (`/wisp/`) | tous les endpoints sensibles, `/wisp/` |
| **404** | Appairage introuvable/expiré ; session inconnue | `/api/pair/status`, `/api/session/revoke` |
| **405** | Méthode non prévue pour la route (routeur par méthode) | routes hors `OPTIONS` préflight |
| **429** | Trop d'appairages en attente | `/api/pair/request` |

## 5. Versionnement et capacité négociée

- **`wispVersion`** : annoncé par `/health`, **`1`** aujourd'hui. Le frontend
  exige `wispVersion === PROXY_WISP_VERSION` (`packages/vm-network/src/proxy.ts`,
  constante `1`) ; toute autre valeur → état **`incompatible`**, sans appairage.
  Voir `apps/web/src/features/proxy/detect.ts`.
- **`version`** : version du binaire, informative (aucune contrainte de parité
  stricte frontend↔proxy au-delà de `wispVersion`).
- **Capacités négociées** : le mode effectif dépend du proxy connecté. Le profil
  `local-proxy` expose les mêmes capacités de transport que `user-relay`
  (`https = true`, `cors = false`) mais **`fullInternet` reste `false` par
  défaut** : seule une sonde à l'exécution depuis l'invité prouve la connectivité
  (`packages/vm-network/src/modes.ts`).
- Toute évolution du protocole WISP exige une **montée de version conjointe**
  (frontend + proxy) et un **nouvel ADR**.

## 6. Cycle de vie du token (côté web)

1. `POST /api/pair/request` → `pairingId` + `userCode` ; afficher le code.
2. `GET /api/pair/status?id=…` (polling) jusqu'à `approved`/`denied`.
3. `POST /api/pair/exchange` `{pairingId}` → `token`.
4. `GET /api/session/verify?token=…` → `{ok:true}` impératif avant tout état
   « connecté » ; puis `ws://127.0.0.1:37892/wisp/?token=…` pour v86.
5. Persistance : le token peut être conservé (`localStorage`
   `lumiboot.proxy.session`) **lié à l'URL du proxy et à son expiration** ; il est
   supprimé à la révocation/expiration. Compromis assumé, voir
   [`network-proxy.md` → Sécurité](network-proxy.md#sécurité).
6. Révocation : `POST /api/session/revoke` `{token}`, ou `revoke <id|all>` depuis
   la console locale.

## 7. Règle d'affichage « connecté »

`GET /health` prouve seulement que le proxy **répond** : il ne prouve ni
l'origine autorisée, ni la validité d'un token. Le web ne doit afficher un état
**connecté** qu'après une **vérification authentifiée réussie**
(`GET /api/session/verify` → `200 {"ok":true}`), effectuée avec le même `Origin`
que le navigateur. Un `/health` OK **sans** vérification valide laisse l'état à
`pairing-required` — jamais `connected`
(`apps/web/src/features/proxy/store.ts`).

## 8. Limites connues

- **Token en query** visible dans les journaux locaux (conséquence assumée du
  client v86 0.5.471) : TTL courte possible et révocation à tout moment.
- **UDP non supporté** (refus `0x41`), pas d'écoute entrante, ICMP non garanti.
- **Plateformes mobiles non supportées**.
- Le proxy n'est **jamais** exposé hors loopback (sauf `allowNonLoopback: true`
  explicite, déconseillé).
