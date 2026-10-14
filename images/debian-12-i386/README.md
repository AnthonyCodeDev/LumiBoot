# Image Debian 12 Bookworm i386 (v86)

> **Statut : non construit.** Ce dossier est un squelette de Lot 1. Aucun binaire n'est présent et
> aucun checksum réel n'a encore été produit. Ne pas marquer Debian « Disponible » avant que les
> tests de `tests/boot-smoke-test.md` passent.

## Objectif

Fournir une image Debian 12 i386 **légale, reproductible et documentée**, démarrable dans le
navigateur via v86, avec une console série utilisable.

## Contenu

| Fichier | Rôle |
|---|---|
| `manifest.json` | Architecture, taille, `sha256`, fichiers, licence, version v86 cible |
| `build.sh` | Construction reproductible (Linux/Docker) |
| `tests/boot-smoke-test.md` | Tests de démarrage réels et critères d'acceptation |

## Méthode prévue (Lot 1)

1. Récupérer les composants Debian i386 (noyau `linux-image-686`, initrd, rootfs) depuis les
   archives officielles — provenance et licence consignées dans `manifest.json`.
2. Construire une image disque + initrd, ou un rootfs montable par v86.
3. Calculer `sha256` et tailles, puis les inscrire dans le manifeste.
4. Servir l'image depuis un stockage statique (pas Git) et l'enregistrer via
   `registerImageManifest()` du package `@lumiboot/vm-assets`.
5. Exécuter le smoke test, renseigner `availability: 'ready'` uniquement si tout passe.

## Contraintes

- Debian 13 (Trixie) n'est **pas** une base valide : l'installateur et le noyau i386 natifs y ont
  été supprimés.
- Les gros fichiers restent hors Git (`.gitignore`).
