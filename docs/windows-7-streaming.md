# Streaming HTTP Range des disques locaux

Ce pipeline sert un disque RAW sans le copier dans `public/` ni le charger entièrement en mémoire.

## Composants

| Fichier | Rôle |
|---|---|
| `scripts/prepare-windows7-asset.mjs` | manifeste, provenance et SHA-256 streaming |
| `scripts/lib/disk-asset-dev.mjs` | découverte des manifestes et middleware Vite |
| `scripts/lib/range-server.mjs` | implémentation HTTP Range partagée |
| `scripts/serve-windows7-asset.mjs` | serveur autonome loopback avec token |
| `packages/vm-assets/src/local-disk.ts` | validation du manifeste |

## Contrat HTTP

v86 sonde avec `Range: bytes=0-0` puis lit le disque par plages. Le serveur doit renvoyer :

- `206 Partial Content` pour une plage valide ;
- `Content-Range`, `Content-Length` et `Accept-Ranges: bytes` exacts ;
- `416` avec `Content-Range: bytes */<taille>` pour une plage invalide ;
- aucune compression sur le contenu binaire.

Une réponse `200` à une requête Range n'est pas compatible avec le lecteur asynchrone de v86.

## Serveur autonome

```bash
pnpm assets:windows7:serve
# ou
node scripts/serve-windows7-asset.mjs \
  --manifest images/windows-7-x86/manifest.json \
  --port 37893
```

Par défaut il écoute sur `127.0.0.1` et génère un token accepté en query string ou via `X-Lumiboot-Token`. Une adresse non-loopback exige `--expose` et rend potentiellement le disque téléchargeable : ne pas l'utiliser en production sans contrôle d'accès adapté.

## Vérification

```bash
pnpm assets:windows7:check
pnpm test -- --run tests/prepare-windows7-asset.test.ts tests/range-server.test.ts
```

COOP/COEP n'est pas requis par v86 0.5.471. Il reste activable avec `LUMIBOOT_COOP_COEP=1` pour de futurs moteurs.
