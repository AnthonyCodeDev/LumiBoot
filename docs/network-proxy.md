# Proxy réseau local

Le LumiBoot Network Proxy est le binaire Go de `apps/network-proxy`. Il expose WISP V1 sur `127.0.0.1:37892` et ouvre des connexions TCP sortantes au nom de l'invité. Il ne lance aucune VM.

## Flux

1. Le frontend vérifie `GET /health` et la version WISP.
2. Il crée une demande avec `POST /api/pair/request`.
3. L'utilisateur approuve le code dans la console du proxy.
4. Le frontend échange l'approbation contre un token, puis le vérifie.
5. v86 ouvre `ws://127.0.0.1:37892/wisp/?token=…`.

`/health` prouve seulement que le processus répond. L'état `connected` exige un succès de `/api/session/verify`.

## Exécution

```bash
cd apps/network-proxy
go run ./cmd/lumiboot-network
```

Options : `--config PATH`, `--listen 127.0.0.1:37892`, `--version`.

Le fichier de configuration par défaut est `<UserConfigDir>/LumiBoot/Network Proxy/config.json`. Les variables `LUMIBOOT_PROXY_*` peuvent surcharger ses champs ; la liste complète est dans [`../apps/network-proxy/README.md`](../apps/network-proxy/README.md).

## Sécurité

- écoute loopback obligatoire sauf `allowNonLoopback: true` explicite ;
- origine exacte et token liés ;
- token aléatoire stocké sous SHA-256, TTL 24 h par défaut ;
- réseaux privés, loopback, multicast et métadonnées cloud bloqués après DNS ;
- connexion établie vers l'IP validée pour éviter le rebinding ;
- 64 connexions globales et 16 par session par défaut ;
- UDP, écoute entrante et ICMP non pris en charge.

`allowPrivateNetworks` n'autorise jamais les endpoints de métadonnées cloud. Le token figure dans l'URL en raison des limites du client v86 : éviter de journaliser les query strings et révoquer les sessions inutilisées.

## Console

Commandes : `help`, `list`, `status`, `approve <id|code>`, `deny <id|code>`, `revoke <id|all>`, `quit`.

## Validation

```bash
cd apps/network-proxy
go test ./...
go vet ./...
gofmt -l .
```

Le contrat HTTP/WISP exact est dans [`proxy-contract.md`](proxy-contract.md).
