import type { EngineId } from '@lumiboot/contracts';

/**
 * Métadonnées des moteurs d'exécution.
 *
 * `integrated` indique si le moteur est réellement branché dans ce dépôt.
 * Tant qu'il vaut `false`, aucun système associé ne peut être annoncé comme
 * disponible, quelle que soit son entrée de catalogue.
 */
export interface EngineDefinition {
  id: EngineId;
  label: string;
  /** Où le calcul a lieu. */
  runtime: 'browser';
  description: string;
  integrated: boolean;
}

export const engines: Record<EngineId, EngineDefinition> = {
  v86: {
    id: 'v86',
    label: 'v86 / WebAssembly',
    runtime: 'browser',
    description: 'Émulateur x86 32 bits en WebAssembly, exécuté dans l’onglet du visiteur.',
    integrated: true,
  },
  'wasm-x86': {
    id: 'wasm-x86',
    label: 'WASM x86',
    runtime: 'browser',
    description: 'Moteur navigateur prévu pour les systèmes x86 32 bits.',
    integrated: false,
  },
  'wasm-x86_64': {
    id: 'wasm-x86_64',
    label: 'WASM x86-64',
    runtime: 'browser',
    description: 'Moteur navigateur prévu pour les systèmes x86-64.',
    integrated: false,
  },
  'wasm-arm': {
    id: 'wasm-arm',
    label: 'WASM ARM',
    runtime: 'browser',
    description: 'Moteur navigateur prévu pour les systèmes ARM.',
    integrated: false,
  },
  'wasm-powerpc': {
    id: 'wasm-powerpc',
    label: 'WASM PowerPC',
    runtime: 'browser',
    description: 'Moteur navigateur prévu pour les systèmes PowerPC.',
    integrated: false,
  },
  'wasm-68k': {
    id: 'wasm-68k',
    label: 'WASM 68k',
    runtime: 'browser',
    description: 'Moteur navigateur prévu pour les systèmes 68k.',
    integrated: false,
  },
};

export function getEngine(id: EngineId): EngineDefinition {
  return engines[id];
}

export function isEngineIntegrated(id: EngineId): boolean {
  return engines[id].integrated;
}
