# Sécurité — LumiBoot

Ce document résume les règles de sécurité opposables à toute contribution.

## Principes

1. **Aucune commande arbitraire serveur depuis le navigateur.** Les endpoints de session distante
   n'acceptent qu'un identifiant de système du catalogue autorisé.
2. **Ne jamais exécuter QEMU/libvirt dans le processus HTTP.** Worker séparé, hôte privilégié,
   périmètre minimal.
3. **Console non exposée directement.** Accès uniquement via une passerelle avec ticket de courte
   durée, lié à la session et à son propriétaire.
4. **Isolation des VM distantes.** Réseaux dédiés, egress filtré, protection du réseau privé et des
   endpoints de metadata cloud.
5. **Secrets côté serveur uniquement.** Les variables `VITE_*` sont publiques ; ne jamais y placer
   de secret.
6. **WASM et workers.** Vérifier les en-têtes COOP/COEP requis par la version de v86 intégrée avant
   de les imposer globalement (voir `infra/nginx/security-headers.conf`).
7. **Télémétrie.** Opt-in ou minimale ; ne jamais transmettre le contenu du terminal. Aucune donnée
   de session sans consentement explicite.

## Lot 0 (état actuel)

- Aucun backend, aucune session distante, aucun moteur n'est actif.
- Le repli `UnavailableProvider` ne contacte aucun serveur et ne simule rien.
- Les favoris et préférences restent dans `localStorage` du visiteur.

## Signaler une vulnérabilité

Ouvrir un ticket privé auprès des mainteneurs ; ne pas divulguer publiquement avant correction.
