# ADR 0003 — Aucune infrastructure de VM distante

- Statut : accepté
- Date : 2026-10-14

## Décision

LumiBoot ne fournit ni calcul distant, ni API d'orchestration, ni console distante. Les moteurs s'exécutent dans le navigateur et les sessions appellent `stop()` puis `dispose()`.

Cette décision n'interdit pas :

- l'hébergement statique des moteurs et images ;
- le proxy réseau natif exécuté en loopback sur la machine de l'utilisateur ;
- un relais WISP que l'utilisateur administre explicitement.

Ces composants transportent des données mais n'exécutent aucune VM.

## Conséquences

- Aucun secret d'infrastructure ne doit être exposé au frontend.
- Aucun état « disponible » ou « connecté » ne peut être déduit d'une configuration seule.
- Toute extension doit conserver l'exécution locale de la VM.
