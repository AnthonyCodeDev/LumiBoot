# LumiBoot WISP Relay (Docker)

Deploiement d'une passerelle WISP v1 sur un serveur Linux, pour donner aux
machines virtuelles **executees dans le navigateur** un transport TCP/UDP via
WebSocket TLS (`wss://`). Le serveur ne virtualise aucun OS.

## Prerequis

- Un serveur Linux avec Docker Engine + Docker Compose plugin.
- Un sous-domaine (exemple : `relay.example.com`) pointant en DNS A/AAAA vers le serveur.
- Ports TCP 80 et 443 ouverts sur les pare-feu du fournisseur et du serveur.
- Ports 80/443 disponibles : si Nginx/Caddy les utilise deja, integre WISP dans
  le reverse proxy existant au lieu de demarrer le service `caddy` ici.

## Mise en route

```bash
cp .env.example .env
nano .env  # mettre les vrais WISP_DOMAIN et LUMIBOOT_ORIGIN
docker compose config
docker compose up -d --build
docker compose ps
docker compose logs -f --tail=80
```

Caddy demande un certificat TLS automatiquement quand le DNS et les ports
publics sont corrects. Ensuite :

```bash
curl -i https://relay.example.com/healthz
```

Une reponse `200` / `ok` ne valide que le HTTPS de Caddy, **pas** les
connexions WISP sortantes.

## Configuration LumiBoot

Modifier **le fichier deja existant** `apps/web/public/lumiboot.config.json`
(pas besoin d'ajouter une page Settings) :

```json
{
  "version": 1,
  "network": {
    "defaultProfile": {
      "mode": "user-relay",
      "relayUrl": "wss://relay.example.com/"
    },
    "systems": {}
  }
}
```

Adapter l'URL et conserver les autres options eventuelles du JSON existant.
Le provider v86 de LumiBoot convertit deja `wss://` en `wisps://` si ce mapping
existe toujours dans `V86NetworkAdapter.ts`.

Verifier que la Content Security Policy du site LumiBoot autorise
`connect-src 'self' wss://relay.example.com` (en plus de ses autres
sources legitimes). Le WebSocket n'exige pas `Access-Control-Allow-Origin`,
mais Caddy verifie l'en-tete `Origin` exact du site.

Si LumiBoot est ouvert depuis `http://localhost:5173`, la valeur
`LUMIBOOT_ORIGIN` doit etre `http://localhost:5173` (ou 127.0.0.1, selon
l'URL utilisee). Revenir a l'origine HTTPS de production ensuite.

## Tests de bout en bout

1. Depuis la page LumiBoot, demarrer Debian.
2. Dans les devtools Chrome, verifier l'etablissement du WebSocket WSS
   et ses trames (erreur 403 = origine refusee ; 502 = backend inaccessible).
3. Dans Debian : `ip addr`, `ip route`, `getent hosts deb.debian.org`,
   `curl -I https://deb.debian.org/`, `sudo apt update`.
4. Verifier les logs du relais : `docker compose logs --tail=100 wisp`.
5. Verifier le depart des requetes **depuis l'IP du relais**, pas de l'utilisateur.

Le serveur WISP doit pouvoir acceder a Internet via son propre firewall ;
la VM doit posseder ses pilotes reseau et DHCP/DNS. Les tests donnent la
preuve du fonctionnement, pas la seule existence de la config.

## Secu / limitation pour une publication publique

**Ne pas publier tel quel comme relais ouvert a des inconnus.**

- La verification d'`Origin` dans Caddy **n'est pas une authentification**.
  Un client non navigateur peut reproduire cet en-tete. Une URL publique
  dans `lumiboot.config.json` est visible de tous.
- Le serveur WISP possede des limites de debit et connexions, mais derriere
  Caddy il peut voir l'adresse du proxy et non les adresses des visiteurs.
  Les limites ne sont donc pas garanties **par utilisateur**.
- Les options `--allow-private` et `--allow-loopback` ne sont **pas** activees.
  Il faut aussi bloquer les acces aux IP internes et metadonnees cloud
  **au niveau du pare-feu de sortie**, selon ton infrastructure.
- Avant une ouverture publique, ajouter une **authentification reelle**
  des connexions (par exemple autorisation de session courte duree au
  reverse proxy, sans secret permanent publie dans le frontend), des quotas
  par utilisateur, des limites de trafic et une supervision anti-abus.
- Le trafic reseau vers Internet sort avec l'IP de ton serveur : cela a des
  consequences en termes de cout, de signalements d'abus et de responsabilite.
- Le protocole WISP transporte un tunnel de sockets ; le chiffrement TLS
  protege l'acces navigateur-relais, mais les donnees vers les destinations
  dependent des protocoles utilises (HTTPS, SSH, HTTP...).
- Revoir les obligations de licence AGPL-3.0 de `wisp-python` si redistribution
  ou modification ; conserver les mentions de licence.

## Commandes utiles

```bash
docker compose up -d --build        # construction / mise a jour
docker compose logs -f wisp         # logs de la passerelle
docker compose logs -f caddy        # logs HTTPS et certificats
docker compose down                # stop
docker compose config              # verifier la configuration
```
