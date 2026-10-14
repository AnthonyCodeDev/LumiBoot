# ADR 0001 — Exécution locale exclusive

- **Statut :** accepté
- **Date :** 2026-10-14
- **Contexte :** LumiBoot doit rester un client Web pur, sans infrastructure de virtualisation distante,
  sans service backend pour démarrer les machines et sans dépendance à un hôte de calcul externe.

## Décision

LumiBoot exécute les systèmes d'exploitation directement dans le navigateur de l'utilisateur via des
moteurs WebAssembly. L'interface d'exécution est centralisée dans `VMProvider`, résolue par un
`VMRegistry`, et les moteurs sont chargés de façon paresseuse uniquement au besoin.

Aucune API distante, aucun worker d'hyperviseur, aucun service PostgreSQL et aucune passerelle de console
ne font partie de la conception de l'application. Le runtime reste entièrement local.

## Conséquences

- Le catalogue définit l'`engineId` et le mode d'exécution au niveau du profil de lancement, pas au niveau du disque.
- La compatibilité est explicite et vérifiée par le moteur disponible dans le navigateur du visiteur.
- L'UI n'accède jamais à un environnement de calcul distant : elle n'interagit qu'avec un handle de session local.
- Toute extension future doit rester compatible avec un modèle navigateur-only, sans infrastructure serveur fictive.
