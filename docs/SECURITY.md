# Sécurité — LumiBoot

Ce document résume les règles de sécurité opposables à toute contribution.

## Principes

1. **Aucune commande arbitraire serveur depuis le navigateur.** Le navigateur ne peut lancer que des sessions locales autorisées par le catalogue.
2. **Aucune VM distante.** Les moteurs d'émulation restent dans le navigateur de l'utilisateur ; aucun worker, hôte ou API backend n'est requis pour l'exécution.
3. **Console non exposée directement.** L'affichage du terminal reste encapsulé dans l'interface locale de la session.
4. **Isolation locale.** Les sessions sont isolées dans le contexte navigateur, sans réseau privé ni metadata cloud.
5. **Secrets et variables d'environnement.** Les variables `VITE_*` sont publiques ; ne jamais y placer de secret. Les vrais secrets ne doivent jamais être ajoutés au dépôt.
6. **WASM et workers.** Vérifier les en-têtes de sécurité statiques et leur héritage dans les blocs `location` Nginx avant d'activer des workers locaux (voir `infra/nginx/security-headers.conf`).
7. **Télémétrie.** Opt-in ou minimale ; ne jamais transmettre le contenu du terminal. Aucune donnée de session sans consentement explicite.

## État actuel

- Le moteur v86 est intégré : Debian 12 i386 démarre réellement dans le navigateur, sans backend ni VM
  distante.
- Le sous-système réseau (`@lumiboot/vm-network`) reste local ; sa configuration est globale et
  publique (`apps/web/public/lumiboot.config.json`), sans page Settings.
- Le repli `UnavailableProvider` ne contacte aucun serveur et ne simule rien.
- Les favoris de l'interface restent dans `localStorage` du visiteur.

## Signaler une vulnérabilité

Ouvrir un ticket privé auprès des mainteneurs ; ne pas divulguer publiquement avant correction.
