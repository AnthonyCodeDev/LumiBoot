# Relais WISP distant

Déploiement Docker optionnel d'un relais WISP derrière Caddy. Le relais transporte le réseau des invités ; il n'exécute aucune VM.

## Prérequis

- serveur Linux avec Docker Compose ;
- sous-domaine pointant vers le serveur ;
- ports 80 et 443 disponibles.

## Démarrage

```bash
cp .env.example .env
# Renseigner WISP_DOMAIN et LUMIBOOT_ORIGIN.
docker compose config
docker compose up -d --build
docker compose logs -f --tail=80
curl -i https://relay.example.com/healthz
```

`/healthz` vérifie Caddy, pas le transport WISP.

## Configuration LumiBoot

Dans `apps/web/public/lumiboot.config.json` :

```json
{
  "mode": "user-relay",
  "relayUrl": "wss://relay.example.com/"
}
```

Autoriser aussi le domaine dans la directive CSP `connect-src`. Le `LUMIBOOT_ORIGIN` de Caddy doit correspondre exactement à l'origine du frontend.

## Test

Depuis l'invité :

```bash
ip -br addr
getent hosts deb.debian.org
curl -I https://deb.debian.org/
```

## Avertissement

Cette configuration ne constitue pas un relais public sécurisé. `Origin` n'est pas une authentification face à un client non navigateur. Avant toute exposition à des tiers, ajouter authentification, quotas par utilisateur, filtrage egress, supervision et gestion des abus. Le trafic sort avec l'IP du serveur. Vérifier également les obligations AGPL-3.0 de `wisp-python`.

Arrêt : `docker compose down`.
