# LumiBoot

LumiBoot est un catalogue React qui exécute des systèmes x86 directement dans le
navigateur avec **v86 / WebAssembly**. Aucun serveur de virtualisation : tout
tourne en local, et aucun démarrage ni état de disponibilité n'est simulé.

## Systèmes disponibles

Tous tournent sur le moteur **v86 / WebAssembly (x86 32 bits)**.

| Système | Variantes | Média | RAM |
|---|---|---|---|
| Debian 12 | CLI, X11/Openbox, XFCE | image ext4 locale (kernel + initrd) | 512 Mio / 1 Gio / 1 Gio |
| Windows 7 | Professionnel SP1, Lite | disques RAW locaux (32 / 16 Gio) | 1536 / 1024 Mio |
| Windows 10 x86 | 32 bits | disque RAW local (40 Gio) | 2048 Mio |

Les images volumineuses et les médias propriétaires ne sont pas versionnés. La
disponibilité est dérivée de quatre faits : image présente, profil compatible,
moteur intégré et boot validé.

## Démarrer

Prérequis : Node.js 20+ et pnpm 9.14.2.

```bash
pnpm install
pnpm assets:prepare
pnpm dev
```

Application : `http://127.0.0.1:5173`.

`assets:prepare` installe les binaires v86 verrouillés par
`scripts/v86-assets.lock.json`. Les images Debian se construisent et se publient
séparément : voir [`images/debian-12-i386/README.md`](images/debian-12-i386/README.md).

## Commandes

```bash
pnpm build          # typecheck puis bundle Vite
pnpm typecheck      # tous les packages TypeScript
pnpm lint           # ESLint
pnpm format:check   # vérification Prettier
pnpm test           # Vitest
pnpm test:e2e       # Playwright, port 5200
pnpm assets:check   # intégrité des binaires v86
```

Les boots réels sont opt-in car ils nécessitent plusieurs gigaoctets d'assets :

```powershell
$env:VM_E2E_ASSETS='1'
pnpm test:e2e
```

Playwright utilise toujours le port `5200` ; le port `5173` reste réservé au
serveur de développement.

## Architecture

| Chemin | Rôle |
|---|---|
| `apps/web` | interface React/Vite, catalogue et sessions |
| `apps/network-proxy` | proxy WISP V1 local en Go |
| `packages/contracts` | types et schémas Zod |
| `packages/catalog` | images, profils, moteurs, variantes et disponibilité |
| `packages/vm-core` | contrats moteur, registre et cycle de vie |
| `packages/provider-v86` | intégration v86, readiness, console et réseau |
| `packages/vm-assets` | manifestes, intégrité et disques locaux |
| `packages/vm-storage` | stockage versionné et quotas |
| `packages/vm-network` | profils, capacités et diagnostics réseau |
| `images` | scripts de build et assets locaux ignorés |

Flux : l'UI crée une session, `VMRegistry` charge le moteur à la demande,
`V86Provider` vérifie le manifeste puis démarre l'émulateur. `running` exige un
marqueur invité Debian ou une lecture disque réelle en mode `disk-boot`. L'arrêt
appelle `stop()` puis `dispose()`.

Voir [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) pour les responsabilités et
invariants.

## Réseau

- `offline` : aucune NIC ;
- `browser-fetch` : HTTP 80 uniquement, soumis à CORS ;
- `local-proxy` : TCP sortant via le binaire local sur `127.0.0.1:37892` ;
- `user-relay` : relais WISP fourni par l'utilisateur.

La configuration publique se trouve dans `apps/web/public/lumiboot.config.json`.
Le proxy local nécessite un appairage approuvé dans sa console. Voir
[`docs/network.md`](docs/network.md) et [`docs/network-proxy.md`](docs/network-proxy.md).

## Médias locaux

- Debian : construire avec `images/debian-12-i386/build.sh`, puis publier dans
  `apps/web/public/images/<ref>/`.
- Windows 7 : placer le RAW dans `images/<ref>/disk.img`, générer son manifeste
  avec `scripts/prepare-windows7-asset.mjs`, puis lancer `pnpm dev`. Le middleware
  Vite le sert in-place par HTTP Range.
- Windows 10 : placer le RAW dans `images/windows-10-x86/disk.img`, générer son
  manifeste avec `scripts/prepare-windows10-asset.mjs`, puis lancer `pnpm dev`.

Voir [`docs/windows-7.md`](docs/windows-7.md),
[`docs/windows-10.md`](docs/windows-10.md) et [`docs/LICENSES.md`](docs/LICENSES.md).

## Windows 10

Windows 10 32 bits suit le **même pipeline disque RAW local** que Windows 7,
depuis un disque RAW **que vous fournissez** (installation personnelle convertie
depuis QEMU/VirtualBox) : boot lent, stockage invité éphémère (source en lecture
seule). Le **boot réel est prouvé** (test E2E
`tests/e2e/windows10-desktop.spec.ts`, `VM_E2E_ASSETS=1`). Le matériel réseau
`virtio-net` est configuré (pilote VirtIO NetKVM x86 présent dans l'image), mais
la **connectivité invitée n'est pas encore vérifiée** par un test. Aucune ISO ni
image Windows n'est téléchargée ou redistribuée : une licence Windows vous est
requise.

```powershell
pnpm assets:windows10:prepare --source "D:\VM\Windows10-32bit.img" --skip-hash
pnpm assets:windows10:check
pnpm dev
```

Les options se passent **sans** le séparateur `--`.

Conversion légitime du disque, RAM 2048 Mio, matériel ACPI/virtio-net, preuve de
boot et checklist : [`docs/windows-10.md`](docs/windows-10.md).

## Documentation

- [`docs/AGENT_BRIEF.md`](docs/AGENT_BRIEF.md) — règles de contribution techniques
- [`docs/system-variants.md`](docs/system-variants.md) — groupes et ordre des variantes
- [`docs/SECURITY.md`](docs/SECURITY.md) — invariants de sécurité
- [`docs/adr/`](docs/adr/) — décisions d'architecture
