import type { Architecture } from '@lumiboot/contracts';

export type RuntimeTarget = 'browser';

/**
 * Fonctionnalités réellement offertes par un moteur. Une UI ou un orchestrateur
 * doit consulter `capabilities()` avant de proposer snapshots, reprise ou
 * téléchargement partiel — toutes les options ne sont pas universelles.
 */
export interface VMCapabilities {
  readonly runtime: RuntimeTarget;
  readonly architectures: readonly Architecture[];
  /** Snapshot complet RAM + CPU. */
  readonly ramSnapshots: boolean;
  /** Snapshot du disque seul, sans l'état mémoire. */
  readonly diskSnapshots: boolean;
  /** Téléchargement partiel via requêtes HTTP Range. */
  readonly partialDownload: boolean;
  /** Reprise d'une session précédemment interrompue. */
  readonly resumable: boolean;
  /** Mémoire invitée configurable. */
  readonly configurableMemory: boolean;
}

export const NO_CAPABILITIES: VMCapabilities = {
  runtime: 'browser',
  architectures: [],
  ramSnapshots: false,
  diskSnapshots: false,
  partialDownload: false,
  resumable: false,
  configurableMemory: false,
};
