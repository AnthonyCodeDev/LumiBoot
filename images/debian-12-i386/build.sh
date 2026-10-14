#!/usr/bin/env bash
# Construction reproductible de l'image Debian 12 i386 pour v86 (Lot 1).
#
# ATTENTION : script squelette. Il décrit la procédure mais n'est pas encore
# validé. Exécuter sur Linux ou dans Docker, jamais committer les binaires.
set -euo pipefail

RELEASE="bookworm"
ARCH="i386"
OUT_DIR="$(dirname "$0")/build"
mkdir -p "$OUT_DIR"

echo "1. Télécharger noyau + initrd i386 officiels..."
# Exemple (à adapter et à vérifier) :
#   debian-installer i386 netboot / archive du noyau linux-image-686
# curl -fSL -o "$OUT_DIR/vmlinuz"  "<url-officielle>"
# curl -fSL -o "$OUT_DIR/initrd"   "<url-officielle>"

echo "2. Construire le rootfs / disque..."
# Extraire un rootfs minimal, préparer /etc, activer la console série ttyS0.

echo "3. Assembler l'image disque..."
# dd + système de fichiers, ou image montable.

echo "4. Calculer les empreintes..."
sha256sum "$OUT_DIR"/* > "$OUT_DIR/SHA256SUMS" || true

echo "5. Mettre à jour manifest.json (taille, sha256, statut)."
echo "Terminé (squelette) — compléter puis exécuter tests/boot-smoke-test.md"
