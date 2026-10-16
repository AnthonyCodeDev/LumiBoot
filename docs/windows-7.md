# Windows 7 Super Lite x86 sous v86 (média utilisateur)

## Résumé honnête

Windows 7 **Super Lite** (x86) est **sélectionnable** dans la bibliothèque et
**exécutable depuis un média que l'utilisateur importe lui-même**. LumiBoot ne distribue
**aucun** média Windows : le système est donc annoncé **`resource-required`**
(« Ressource requise ») tant que l'utilisateur n'a pas fourni un disque légal.
Aucun état « Disponible » (`ready`) n'est affiché, car **aucun boot Windows réel
n'est encore validé de bout en bout**.

Ce document décrit l'intégration réelle (pas une maquette) et les blocages
exacts.

## Choix technique : le moteur

v86 est le seul moteur navigateur **x86 32 bits réellement intégré** au dépôt.
C'est un émulateur PC complet : il démarre une image disque par **BIOS** (MBR),
sans noyau Linux. Windows 7 **32 bits** est donc rattachable à `engineId: v86`
(`executionMode: browser`). Aucun moteur WASM x86-64 n'existe : Windows 7 x64,
Windows 8+ et Windows 10/11 restent hors de portée.

Le profil `windows-7-x86` (voir `packages/catalog/src/profiles.ts`) :

- `engineId: 'v86'`, `executionMode: 'browser'` ;
- mémoire invitée **1024 Mio** (voir la contrainte de puissance de deux ci-dessous) ;
- matériel émulé : disque IDE, VGA, PS/2, **NIC ne2k**, **ACPI activée**
  (requise par la famille Vista+, cf. `docs/windows-nt.md` de v86) ;
- preuve de démarrage `mode: 'disk-boot'`.

### Mémoire : pourquoi 1024 et non 1536

Le disque de référence a été préparé sous QEMU avec **1536 Mio** de RAM. Or
`memory_size` de v86 **exige une puissance de deux** (`assertPowerOfTwoMiB` dans
`V86Provider.ts`) : 1536 Mio est refusé au démarrage. Windows Super Lite tourne
avec le plancher documenté par v86 pour la famille Vista+ (≥ 512 Mio) ; 1024 Mio
est donc retenu, et 2048 Mio reste possible via une configuration d'exécution
sans modifier le catalogue.

### NIC : ce que v86 sait réellement émuler

`v86.d.ts` ne déclare que `"ne2k" | "virtio"` pour `net_device.type` : **e1000
et rtl8139 n'existent pas** dans v86. Windows 7 n'intègre aucun pilote virtio ;
`ne2k` est donc le seul choix plausible. Attention : Windows 7 **ne fournit pas
non plus** de pilote NE2000 par défaut — le réseau nécessite l'installation d'un
pilote NE2000 par l'utilisateur (cf. `docs/windows-nt.md` de v86). Le démarrage,
lui, ne dépend pas du réseau.

## Séparation des responsabilités

| Couche | Rôle | Fichiers |
|---|---|---|
| Catalogue | Service média (`mediaStrategy: 'user-import'`), état dérivé `resource-required` | `packages/catalog/src/{images,systems,availability,profiles}.ts`, `packages/contracts/src/catalog.schema.ts` |
| Import/validation | Schéma Zod du manifeste utilisateur, contrôle taille/SHA-256, store | `packages/vm-assets/src/user-media.ts` |
| Persistance navigateur | IndexedDB (repli mémoire), rien n'est envoyé au serveur | `apps/web/src/features/media/*` |
| Exécution | Démarrage BIOS du disque importé, états de session | `packages/provider-v86/src/*`, `packages/vm-core/*` |
| UI | Carte, fiche, import, messages | `apps/web/src/components/media/UserMediaImportCard.tsx`, `apps/web/src/pages/SystemPage.tsx` |

Aucun composant ne teste `name === 'Windows'` : la disponibilité et la
compatibilité sont dérivées des faits (`getEffectiveAvailability`,
`getCompatibility`, `getLaunchReadiness`).

## Cycle de vie d'une session

États normalisés : `idle → preparing → downloading → booting → running →
stopping → stopped` (+ `error`).

- `downloading` correspond au **chargement par HTTP Range** du disque importé
  (v86 lit `hda` par plages ; le blob local est lu via son URL `blob:`).
- `running` n'est émis qu'après une **lecture réelle du disque dur** par
  l'invité (`ide-read-end`, canal 0). Un média non amorçable ne produit jamais
  cet événement : aucun `running` n'est simulé.
- Si aucun média n'est importé, le provider échoue avec `MEDIA_REQUIRED` et
  l'interface affiche « Ressource requise », jamais une fausse progression.

> **Portée de la preuve `disk-boot`.** Contrairement à Debian (marqueur
> `LUMIBOOT_GUEST_READY` émis par l'OS réellement démarré), Windows n'émet aucun
> marqueur LumiBoot. La preuve `disk-boot` atteste que **l'amorce invitée
> s'exécute** (le BIOS lit bien le disque fourni) ; elle **ne prouve pas** que le
> bureau Windows est opérationnel. C'est pourquoi le système reste non `ready`.

## Immutabilité du disque et persistance des écritures

- **Base immuable.** Le fichier source n'est jamais monté en écriture ni
  modifié. Le navigateur ne l'expose à v86 que sous forme d'une `Blob` locale
  (`URL.createObjectURL`), lue par v86 en **lecture seule** (`hda.async`). Aucun
  chemin de code n'ouvre le média en écriture.
- **Overlay éphémère par session.** v86 journalise les écritures de l'invité
  (blocs « dirty ») dans un **tampon mémoire interne à l'instance** ; ces écritures
  ne sont jamais propagées à la base et sont **perdues à l'arrêt** de la session.
  C'est le comportement attendu : LumiBoot ne prétend **pas** persister la session
  invitée.
- **Aucune fausse persistance.** L'IndexedDB ne conserve que le média importé par
  l'utilisateur (pour éviter de le resélectionner) ; elle ne conserve aucune
  modification faite dans Windows. Si le stockage persistant est indisponible,
  LumiBoot retombe explicitement sur un store mémoire et le signale : le média
  doit alors être réimporté après rechargement.

## Préparation du média (utilisateur)

1. Installer Windows 7 **x86** depuis **votre** support et **votre** clé, dans une
   VM que vous contrôlez (QEMU ou v86).
2. Choisir le type d'ordinateur **« Standard PC »** et la NIC **NE2000 (ne2k)**.
3. Exporter le disque au format brut (`.img`/`.raw`).
4. Importer le fichier dans la fiche Windows 7, joindre éventuellement un
   manifeste (`images/windows-7/manifest.example.json`) et attester la licence.

Instructions détaillées : [`images/windows-7/README.md`](../images/windows-7/README.md).

## Limites techniques connues (documentées honnêtement)

- **Grands disques / mémoire.** Le disque importé est exposé à v86 via une URL
  `blob:` locale (`hda.async`). Selon le navigateur, une requête Range sur une
  URL `blob:` peut renvoyer le fichier entier : un disque de plusieurs Go peut
  alors solliciter fortement la mémoire. Cible raisonnable : disque ≤ quelques
  Go. *TODO : support de lecture en flux via OPFS / `FileSystemSyncAccessHandle`
  pour éviter la mise en mémoire complète.*
- **Performance.** Émulation logicielle : démarrage de plusieurs minutes, pas
  d'accélération matérielle.
- **Persistance.** Les octets sont conservés en IndexedDB ; si le stockage est
  indisponible, il faut resélectionner le média après rechargement (repli
  mémoire explicite, jamais présenté comme persistant).
- **Vérification d'intégrité.** Le SHA-256 n'est calculé que si un manifeste
  fournit une empreinte **et** que le fichier est sous le cap (256 Mio par
  défaut). Au-delà, le média est marqué `unverified` plutôt que faussement
  « vérifié ». *TODO : hachage en flux pour les gros fichiers.*

## Blocages / conditions pour passer `ready`

Le système ne deviendra `ready` qu'une fois **toutes** ces conditions réunies :

1. Un disque Windows 7 x86 amorçable existe et est importé (fourni légalement).
2. Un **boot réel** atteint l'environnement graphique sous v86 dans un
   navigateur cible, de façon reproductible.
3. Une **preuve de démarrage forte** est disponible. Windows n'émettant pas de
   marqueur LumiBoot, il faudra soit un agent invité dédié, soit une preuve
   visuelle/écran vérifiable et documentée, ajoutée au profil.
4. Les performances et la stabilité sont mesurées et documentées.

En l'absence de ces preuves, l'état reste volontairement `resource-required`.

## Licences

Voir [`LICENSES.md`](LICENSES.md). En résumé : média et licence **fournis par
l'utilisateur** ; aucune ISO, clé ou image Windows n'est distribuée, téléchargée
ou committée.
