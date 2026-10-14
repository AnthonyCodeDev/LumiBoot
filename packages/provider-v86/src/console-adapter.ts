/**
 * Adaptateur de console. Il isole totalement le rendu v86 (VGA + série) du
 * reste de l'application : le composant React ne fait que fournir un conteneur.
 *
 * Implémentation réelle au Lot 1 (canvas VGA + flux série DOM).
 */
export interface V86ConsoleAdapter {
  attach(container: HTMLElement): void;
  onSerial(listener: (text: string) => void): () => void;
  detach(): void;
}
