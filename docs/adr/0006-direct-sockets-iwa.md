# ADR 0006 — Direct Sockets dans une Isolated Web App

- Statut : proposé, non implémenté
- Date : 2026-10-15

## Proposition

Étudier un transport TCP/UDP direct pour une future Isolated Web App Chrome disposant de la permission `direct-sockets`. Une page Web ou une PWA ordinaire ne possède pas cette API.

Le transport vivrait dans `@lumiboot/vm-network`, pas dans `VMEngine`. Une pile IP côté navigateur resterait nécessaire pour convertir les trames Ethernet de l'invité en sockets.

## Limites

- aucun code ni mode `direct-sockets` n'existe aujourd'hui ;
- pas d'ICMP ni de sockets IP bruts ;
- distribution IWA signée et installée ;
- trafic sortant depuis l'adresse IP de l'utilisateur.

Toute implémentation demandera une nouvelle validation de sécurité, de licence et de distribution.
