# ADR 0007 — Proxy réseau local

- Statut : accepté
- Date : 2026-10-15

## Décision

`apps/network-proxy` fournit un binaire Go multiplateforme qui expose WISP V1 sur `127.0.0.1:37892`. Il établit uniquement des connexions TCP sortantes ; il n'exécute aucune VM.

Le navigateur doit demander un appairage, faire approuver le code dans la console du proxy, puis échanger l'autorisation contre un token lié à l'origine. Le token est stocké haché et transmis dans l'URL WISP parce que v86 0.5.471 ne permet ni en-tête ni sous-protocole WebSocket personnalisé.

## Garde-fous

- écoute loopback par défaut ;
- origine exacte et token obligatoires ;
- blocage des réseaux privés, loopback et métadonnées cloud après résolution DNS ;
- quotas, délais, révocation et arrêt gracieux ;
- UDP refusé, aucun trafic entrant, ICMP non garanti.

Le protocole HTTP est défini dans [`../proxy-contract.md`](../proxy-contract.md) et l'exploitation dans [`../network-proxy.md`](../network-proxy.md).
