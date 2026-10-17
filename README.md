# LumiBoot

LumiBoot est un catalogue React qui exécute localement des systèmes x86 dans le navigateur avec v86/WebAssembly. Il n'utilise aucun serveur de virtualisation et ne simule ni démarrage ni disponibilité.

## État actuel

| Système | État | Ressource |
|---|---|---|
| Debian 12 CLI | prêt | image ext4 locale, 512 Mio de RAM |
| Debian 12 X11/Openbox | prêt | image ext4 locale, 1 Gio de RAM |
| Debian 12 XFCE | prêt | image ext4 locale, 1 Gio de RAM |
| Windows 7 Professionnel/Lite | prêt en développement local | disques RAW opérateur de 32/16 Gio |
| Ubuntu, Fedora, Mint, Windows 10/11, macOS | prévu | moteur ou image absent |

Les images volumineuses et médias propriétaires sont ignorés par Git. La disponibilité est dérivée de quatre faits : image présente, profil compatible, moteur intégré et boot validé.

## Démarrer

Prérequis : Node.js 20+ et pnpm 9.14.2.

```bash
pnpm install
pnpm assets:prepare
pnpm dev
```

Application : `http://127.0.0.1:5173`.

`assets:prepare` installe les binaires v86 verrouillés par `scripts/v86-assets.lock.json`. Les images Debian doivent être construites et publiées séparément : voir [`images/debian-12-i386/README.md`](images/debian-12-i386/README.md).

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

Playwright utilise toujours le port `5200`; le port `5173` reste réservé au serveur de développement.

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

Flux : l'UI crée une session, `VMRegistry` charge le moteur à la demande, `V86Provider` vérifie le manifeste puis démarre l'émulateur. `running` exige un marqueur invité Debian ou une lecture disque réelle en mode `disk-boot`. L'arrêt appelle `stop()` puis `dispose()`.

Voir [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) pour les responsabilités et invariants.

## Réseau

- `browser-fetch` : HTTP 80 uniquement, soumis à CORS ;
- `local-proxy` : TCP sortant via le binaire local sur `127.0.0.1:37892` ;
- `user-relay` : relais WISP fourni par l'utilisateur ;
- `offline` : aucune NIC ;
- `local-network` : prévu, non implémenté.

La configuration publique se trouve dans `apps/web/public/lumiboot.config.json`. Le proxy local nécessite un appairage approuvé dans sa console. Voir [`docs/network.md`](docs/network.md) et [`docs/network-proxy.md`](docs/network-proxy.md).

## Médias locaux

- Debian : construire avec `images/debian-12-i386/build.sh`, puis publier dans `apps/web/public/images/<ref>/`.
- Windows 7 : placer le RAW dans `images/<ref>/disk.img`, générer son manifeste avec `scripts/prepare-windows7-asset.mjs`, puis lancer `pnpm dev`. Le middleware Vite le sert in-place par HTTP Range.

Voir [`docs/windows-7.md`](docs/windows-7.md) et [`docs/LICENSES.md`](docs/LICENSES.md).

## Windows 10

Windows 10 32 bits suit le **même pipeline disque RAW local validé** que
Windows 7, depuis un disque RAW **que vous fournissez** (installation
personnelle convertie depuis QEMU/VirtualBox) : boot lent, stockage invité
éphémère (source en lecture seule), réseau invité probablement absent (pas de
pilote NE2000 inbox). Aucune ISO ni image Windows n'est téléchargée ou
redistribuée : une licence Windows vous est requise. Windows 10 n'étant plus
maintenu (support standard terminé en 2025), n'utilisez pas une session
connectée à Internet.

```powershell
pnpm assets:windows10:prepare -- --source "D:\VM\Windows10-32bit.img"
pnpm assets:windows10:check
pnpm dev
```

Windows 10 64 bits reste bloqué (moteur `wasm-x86_64` non intégré). Conversion
légitime du disque, RAM 2048 Mio, matériel ACPI/ne2k et checklist de validation
réelle : [`docs/windows-10.md`](docs/windows-10.md).

## Documentation

- [`docs/AGENT_BRIEF.md`](docs/AGENT_BRIEF.md) — règles de contribution techniques
- [`docs/system-variants.md`](docs/system-variants.md) — groupes et ordre des variantes
- [`docs/SECURITY.md`](docs/SECURITY.md) — invariants de sécurité
- [`docs/adr/`](docs/adr/) — décisions d'architecture

Le prototype statique d'origine reste dans `prototype/` comme référence visuelle.
