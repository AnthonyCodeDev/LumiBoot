# Windows 7 Super Lite x86 sous v86 — média fourni par l'utilisateur

> **Statut : intégration navigateur réelle, média NON distribué.**
> LumiBoot ne fournit, ne télécharge et ne committe **aucune** image, ISO, clé ou
> fichier Windows. Le catalogue annonce Windows 7 en **`resource-required`**
> (« Ressource requise ») : le système est sélectionnable, son moteur (v86) est
> intégré, mais rien ne démarre avant que **vous** n'importiez un disque que vous
> détenez légalement. Aucun boot Windows n'étant encore validé de bout en bout,
> l'état « Disponible » n'est jamais affiché.

## Ce que contient ce dossier

| Fichier | Rôle |
|---|---|
| `README.md` | Cette notice : préparation légale et import du média. |
| `manifest.example.json` | **Exemple** de manifeste utilisateur optionnel (métadonnées + empreinte). Aucune donnée réelle. |

Aucun binaire d'image n'est committé (voir `docs/LICENSES.md`).

## Prérequis

- Une **licence Windows 7 valide** (retail/OEM) que vous détenez.
- Un **disque préinstallé** Windows 7 **Super Lite** **x86 (32 bits)** au format
  brut (`.img`/`.raw`), que vous avez créé ou obtenez par un moyen légal.
  - v86 démarre par **BIOS** : le disque doit porter un MBR amorçable.
  - Windows 7 64 bits n'est **pas** supporté : v86 n'émule que du x86 32 bits.
  - Le disque est importé en **disque dur (`hda`)**, jamais en cdrom : ce n'est
    pas une ISO.
- **1 Gio de RAM** invitée (le disque de référence a été préparé à 1536 Mio, mais
  v86 n'accepte que des puissances de deux ; 1024 est retenu, 2048 possible).
- Un navigateur moderne fournissant **WebAssembly**.

## Comment obtenir un disque légal

1. Installez Windows 7 x86 dans une machine virtuelle que vous contrôlez
   (QEMU, v86 via copy.sh, etc.) à partir de **votre propre support d'installation**
   et avec **votre propre clé**.
2. Pendant l'installation, choisissez le type d'ordinateur **« Standard PC »**
   (évite les problèmes ACPI des invités NT).
3. Configurez la carte réseau comme **NE2000 (ne2k)** si vous voulez du réseau.
4. Arrêtez proprement Windows, puis **exportez le disque** au format brut
   (`.img`/`.raw`). C'est ce fichier que LumiBoot importera.

> Ne partagez jamais ce fichier : il contient une installation Windows sous
> licence. LumiBoot le garde **uniquement dans votre navigateur**.

## Importer dans LumiBoot

1. Ouvrez la fiche **Windows 7** dans la bibliothèque.
2. Dans **« Média requis (fourni par vous) »**, sélectionnez votre fichier
   `.img`/`.raw`/`.iso`.
3. (Optionnel) Joignez un `manifest.json` dérivé de `manifest.example.json` afin
   de faire vérifier la taille et le SHA-256.
4. Cochez l'attestation de licence, puis **« Importer le média local »**.
5. Le bouton **« Lancer une session »** s'active alors. La session démarre le
   disque importé par BIOS, dans l'onglet.

Le fichier n'est **jamais envoyé** à un serveur : il est conservé dans le
navigateur (IndexedDB). Si le stockage persistant est indisponible, il faut le
ressélectionner après un rechargement de la page.

## Manifeste utilisateur (optionnel)

Voir `manifest.example.json`. Champs :

| Champ | Requis | Description |
|---|---|---|
| `version` | oui | Toujours `1`. |
| `ref` | oui | Identifiant du système visé (ex. `windows-7-x86`). |
| `displayName` | oui | Libellé lisible. |
| `format` | oui | `raw` ou `iso`. |
| `architecture` | oui | `i386` pour Windows 7 x86. |
| `sha256` | non | Empreinte attendue (vérifie l'intégrité si le fichier est ≤ 256 Mio). |
| `sizeBytes` | non | Taille attendue en octets. |
| `license` | oui | Rappel de la licence détenue. |
| `provenance` | oui | Origine du média (source personnelle). |
| `notes` | non | Remarques libres. |

## Preuve de démarrage

Windows n'émet **aucun marqueur LumiBoot**. En mode `disk-boot`, la session
passe à `running` **uniquement après une lecture réelle du disque dur** par
l'invité (le BIOS/l'amorce exécute bien l'image fournie). C'est un signal
d'exécution authentique, mais plus faible qu'un marqueur OS : il prouve que
l'amorce a démarré, pas que Windows est pleinement opérationnel. Voir
[`docs/windows-7.md`](../../docs/windows-7.md).

## Limites connues

- v86 émulé en logiciel : performance faible, démarrage de plusieurs minutes.
- Pas d'accélération GPU ; pilotes graphiques limités.
- Windows 7 64 bits, Windows 8+, non supportés par v86.
- Le boot Windows réel n'est **pas** encore validé de bout en bout dans LumiBoot.
