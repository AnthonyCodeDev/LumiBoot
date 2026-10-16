# ADR 0001 — Exécution locale

- Statut : accepté
- Date : 2026-10-14

## Décision

Les systèmes sont exécutés dans le navigateur par des moteurs WebAssembly chargés à la demande derrière `VMEngine` et `VMRegistry`.

LumiBoot n'utilise aucun hôte de calcul, hyperviseur distant, VNC/RDP ou API d'orchestration de VM. Les assets peuvent être téléchargés et un auxiliaire réseau peut tourner sur la machine de l'utilisateur, mais aucune VM ne s'exécute côté serveur.

## Conséquences

- Le profil de lancement choisit explicitement le moteur et sa configuration.
- La compatibilité est vérifiée avant le démarrage ; l'UI ne simule jamais une session.
- Le cycle de vie local doit toujours libérer le moteur, ses workers et ses écouteurs.
- Les services distants exploités par l'utilisateur, comme un relais WISP, restent optionnels et ne déplacent pas l'exécution de la VM.
