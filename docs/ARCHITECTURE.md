# LUMIBOOT — ARCHITECTURE TECHNIQUE CIBLE

**État du dépôt livré :** ce document décrit l'**architecture cible**. Elle est désormais partiellement réalisée : l'application React (`apps/web`) et les packages `contracts`, `catalog`, `vm-core`, `vm-assets`, `vm-storage`, `provider-v86` existent. Le cœur `vm-core` a été consolidé (voir [`adr/0004-vm-core-consolidation.md`](adr/0004-vm-core-consolidation.md)). Les lots d'exécution locale restent à brancher. L'arbre ci-dessous reste une cible d'évolution, pas la liste des fichiers déjà présents.

## 1. Arborescence proposée

```text
lumiboot/
├── apps/
│   └── web/                               # React + Vite + TypeScript
├── packages/
│   ├── contracts/                         # Types et Zod schemas partagés
│   ├── catalog/                           # Manifestes d'OS et compatibilités vérifiées
│   ├── vm-core/                           # Interface stable / session state machine
│   ├── vm-assets/                         # Manifeste d'assets, téléchargement, cache, SHA-256
│   ├── vm-storage/                        # Stockage persistant versionné et quotas
│   └── provider-v86/                      # Premier moteur réel côté client
├── images/
│   └── debian-12-i386/
├── infra/
│   ├── dev/docker-compose.yml             # Web et services de développement locaux
│   └── nginx/{site.conf,security-headers.conf}
├── tests/
│   └── e2e/{catalog.spec,session-debian.spec}.ts
├── docs/
│   └── adr/
├── .github/workflows/{ci,security}.yml
├── .env.example
├── eslint.config.js
├── tsconfig.base.json
├── pnpm-workspace.yaml
├── package.json
└── README.md
```

La référence `prototype/` doit rester disponible tant que la migration React n'est pas terminée. Les fichiers `.img`, `.iso`, `.qcow2`, `.ext2` ne doivent pas être placés dans Git ; utiliser un stockage d'assets avec checksums et cache adapté.

## 2. Architecture logique

```mermaid
flowchart TB
 U[Utilisateur] --> UI[React UI / catalogue / session]
 UI --> REG[VM Registry + SessionController]
 REG --> V86[V86Provider]
 V86 --> WASM[v86 WebAssembly]
 WASM --> DIMG[Debian 12 i386 image et console]
```

`V86Provider` n'appelle aucune API de calcul. Le téléchargement des assets depuis HTTP/CDN ne constitue pas du calcul distant.

## 3. Contrats du catalogue (proposition)

```ts
type OSFamily = 'linux' | 'windows' | 'macos';
type ExecutionMode = 'browser';
type EngineId = 'v86' | 'wasm-x86' | 'wasm-x86_64' | 'wasm-arm' | 'wasm-powerpc' | 'wasm-68k';
type Availability = 'planned' | 'experimental' | 'ready' | 'unavailable';
type Architecture = 'i386' | 'x86_64' | 'arm64';

interface OSDefinition {
  id: string;
  slug: string;
  family: OSFamily;
  displayName: string;
  versionLabel: string;
  architecture: Architecture;
  executionMode: ExecutionMode;
  engineId: EngineId;
  availability: Availability;
  description: string;
  iconUrl: string;
  minMemoryMiB?: number;
  imageRef?: string; // identifiant de manifest, pas URL arbitraire de l'utilisateur
  requirements: string[];
  licenseNotes?: string;
}
```

**Ne pas inférer la compatibilité du moteur à partir du nom ou du numéro de version.** Chaque entrée a un moteur explicitement assigné et un statut vérifié. Pour Windows/macOS, les assets peuvent être fournis par l'utilisateur ou la plateforme en fonction des droits/licences applicables, jamais automatiquement récupérés d'une source douteuse.

## 4. Contrat providers (proposition)

```ts
type VMState =
  | 'idle' | 'preparing' | 'downloading' | 'booting'
  | 'running' | 'stopping' | 'stopped' | 'error';

type SessionEvent =
  | { type: 'state'; state: VMState }
  | { type: 'progress'; phase: string; loadedBytes?: number; totalBytes?: number }
  | { type: 'error'; code: string; message: string };

interface VMHandle {
  id: string;
  providerId: string;
  stop(): Promise<void>;
  dispose(): Promise<void>;
  subscribe(listener: (event: SessionEvent) => void): () => void;
  // Une UI console est proposée par un adapter séparé :
  // Browser v86 -> VGA/serial DOM.
}

interface VMProvider {
  readonly id: string;
  canRun(os: OSDefinition): boolean;
  start(os: OSDefinition, mountTarget: unknown): Promise<VMHandle>;
}
```

Invariants :
- `canRun` doit rester déterministe et explicite ; les tests de compatibilité du navigateur s'ajoutent avant le lancement.
- Une seule transition `booting -> running` après preuve que le système invité est opérationnel, pas à la fin d'un timer JavaScript.
- `dispose()` est appelé en démontage composant et après `stop()` ; pas de worker WASM orphelin.
- Les erreurs sont typées et traduites en messages utilisateurs.
- Les snapshots et l'hibernation ne font **pas** partie du contrat minimal ; ajouter en capacités optionnelles après validation.

## 5. Routes UI et API

### Frontend

| Route | Contenu | Lot |
|---|---|---|
| `/` | Bibliothèque et système à la une | 0 |
| `/systems/:slug` | Fiche complète système | 0 |
| `/session/:id` | Console interactive et contrôles | 1 |
| `/settings` | Préférences | 2 |

La session navigateur peut avoir un ID généré localement. Elle n'a pas besoin d'un enregistrement dans une DB distante.

## 6. Local only

- Toutes les ressources CPU et RAM utilisées par les systèmes viennent de la machine du visiteur.
- L'hébergement Web distribue uniquement l'application, les moteurs WebAssembly et les images système.
- Aucun backend de virtualisation, aucune passerelle VNC/RDP, aucun streaming vidéo n'entre dans l'architecture.
- La persistance locale repose sur IndexedDB et OPFS, avec validation et quotas.

## 7. Compatibilité initiale et ambitions

| OS / version | Exécution cible | Situation |
|---|---|---|
| Debian 12 i386 | Navigateur avec v86 | Premier système à réaliser et tester |
| Ubuntu historique i386 | Navigateur avec v86 | Étude de compatibilité, version par version |
| Fedora, Ubuntu et Mint modernes x64 | Navigateur avec moteur compatible local | Support local uniquement, sans backend de virtualisation |
| Windows anciens x86 | Navigateur avec moteur compatible local | Comportement et licence à vérifier |
| Windows 10/11 x64 | Non prioritaire | Aucun support direct par v86 ; dépend d'un moteur compatible local |
| macOS modernes | Navigateur avec moteur compatible local | Étude de faisabilité, sans infrastructure distante |
| macOS historiques Intel | Étude séparée par version | Ne pas promettre « toutes les versions » |

**Debian 13 n'est pas la bonne base pour le premier noyau i386 :** Debian a supprimé l'installateur et le noyau i386 natifs à partir de Trixie. Debian 12 i386 est donc une cible de démarrage plus réaliste pour v86.

## 8. Ressources pour vérifications techniques

- https://github.com/copy/v86
- https://github.com/leaningtech/webvm
- https://cheerpx.io/docs/licensing
- https://www.debian.org/ports/i386/
- https://guacamole.apache.org/doc/gug/
- https://developer.apple.com/documentation/virtualization
- https://www.apple.com/legal/sla/

## 9. Convention de qualité

- TypeScript strict, `noUncheckedIndexedAccess` conseillé, tests Vitest/Playwright.
- Les versions et licences des dépendances doivent être verrouillées (`pnpm-lock.yaml`).
- Suivre une convention de commit et documenter les choix structurants.
- Secrets côté API/agents uniquement. Les variables `VITE_*` sont publiques.
- Les composants UI ne font jamais `new V86(...)` directement.
- Tests automatiques de la state machine, des erreurs de lancement, des favoris, de la recherche et de l'accessibilité.
- Chargement lazy du moteur v86 et des assets système.
- Ajouter des en-têtes de sécurité compatibles avec les exigences réelles du WASM et de ses workers locaux (vérifier COOP/COEP selon la version intégrée).
