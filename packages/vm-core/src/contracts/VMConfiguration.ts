/**
 * Paramètres de démarrage d'une machine virtuelle. Tous optionnels : le moteur
 * applique ses valeurs par défaut s'ils sont absents.
 */
export interface VMConfiguration {
    readonly memoryMiB?: number;
    readonly vgaMemoryMiB?: number;
    readonly bootDevice?: string;
    readonly extra?: Readonly<Record<string, string | number | boolean>>;
    readonly signal?: AbortSignal;
}
