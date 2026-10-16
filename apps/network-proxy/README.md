# LumiBoot Network Proxy

Proxy WISP V1 local pour les VM v86 de LumiBoot. Il écoute par défaut sur `127.0.0.1:37892`, ouvre du TCP sortant et n'exécute aucune VM.

## Développer

Prérequis : Go 1.22+.

```bash
go test ./...
go vet ./...
go build ./...
go run ./cmd/lumiboot-network
```

Options :

```text
--config PATH
--listen 127.0.0.1:37892
--version
```

## Configuration

Fichier par défaut : `<UserConfigDir>/LumiBoot/Network Proxy/config.json`.

| Champ | Défaut |
|---|---:|
| `listenAddr` | `127.0.0.1:37892` |
| `maxConnections` | `64` |
| `maxConnectionsPerSession` | `16` |
| `connectTimeout` | `10s` |
| `idleTimeout` | `60s` |
| `dataTimeout` | `30s` |
| `initialBufferPackets` | `32` |
| `maxDataChunk` | `131072` |
| `pairingTTL` | `10m` |
| `sessionTokenTTL` | `24h` |

Autres champs : `allowedOrigins`, `allowPrivateNetworks`, `allowNonLoopback`, `bandwidthLimitBytesPerSecond`.

Chaque champ peut être surchargé par `LUMIBOOT_PROXY_<NOM_EN_MAJUSCULES>`. Cas particuliers : `BANDWIDTH_LIMIT_BPS`, `PAIRING_TTL` et `SESSION_TOKEN_TTL`. Les durées acceptent la syntaxe Go (`10s`, `5m`) ou un nombre de secondes.

## Appairage et console

Le frontend crée une demande, l'utilisateur la valide dans le terminal, puis le frontend reçoit un token lié à son origine. Commandes : `help`, `list`, `status`, `approve`, `deny`, `revoke`, `quit`.

Le token est envoyé à `/wisp/?token=…` parce que v86 0.5.471 ne permet pas d'ajouter un en-tête WebSocket. Il est stocké haché, expire et peut être révoqué.

## Sécurité et limites

- loopback uniquement par défaut ;
- origine et token obligatoires ;
- destinations privées et métadonnées cloud bloquées après DNS ;
- TCP sortant uniquement, sans UDP, ICMP ni port entrant ;
- aucun droit administrateur requis ;
- Windows, Linux et macOS, amd64/arm64.

Contrat complet : [`../../docs/proxy-contract.md`](../../docs/proxy-contract.md). Modèle de sécurité : [`../../docs/network-proxy.md`](../../docs/network-proxy.md).
