import type { VMMedia } from '@lumiboot/contracts';
import type { NetworkProfile } from '@lumiboot/vm-network';

/**
 * Paramètres de démarrage d'une machine virtuelle. Tous optionnels : le moteur
 * applique ses valeurs par défaut s'ils sont absents.
 */
export interface VMConfiguration {
  readonly memoryMiB?: number;
  readonly vgaMemoryMiB?: number;
  readonly bootDevice?: string;
  /**
   * Média disque importé par l'utilisateur (URL de blob locale) pour un
   * démarrage BIOS, sans noyau Linux. Résolu au démarrage par le front-end.
   */
  readonly media?: VMMedia;
  readonly extra?: Readonly<Record<string, string | number | boolean>>;
  readonly network?: NetworkProfile;
  readonly signal?: AbortSignal;
}
