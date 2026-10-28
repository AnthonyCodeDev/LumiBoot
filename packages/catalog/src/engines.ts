import type { EngineId } from '@lumiboot/contracts';

/** `integrated: false` forbids any of its systems from being available. */
export interface EngineDefinition {
  id: EngineId;
  label: string;
  runtime: 'browser';
  description: string;
  integrated: boolean;
}

export const engines: Record<EngineId, EngineDefinition> = {
  v86: {
    id: 'v86',
    label: 'v86 / WebAssembly',
    runtime: 'browser',
    description: '32-bit x86 emulator in WebAssembly, running in the visitor tab.',
    integrated: true,
  },
  v64: {
    id: 'v64',
    label: 'v64 / WebAssembly JIT',
    runtime: 'browser',
    description: '64-bit x86 emulator with a WebAssembly JIT, Workers and optional WebGPU.',
    integrated: true,
  },
  'wasm-x86': {
    id: 'wasm-x86',
    label: 'WASM x86',
    runtime: 'browser',
    description: 'Browser engine for 32-bit x86 systems.',
    integrated: false,
  },
  'wasm-x86_64': {
    id: 'wasm-x86_64',
    label: 'WASM x86-64',
    runtime: 'browser',
    description: 'Browser engine for x86-64 systems.',
    integrated: false,
  },
  'wasm-arm': {
    id: 'wasm-arm',
    label: 'WASM ARM',
    runtime: 'browser',
    description: 'Browser engine for ARM systems.',
    integrated: false,
  },
  'wasm-powerpc': {
    id: 'wasm-powerpc',
    label: 'WASM PowerPC',
    runtime: 'browser',
    description: 'Browser engine for PowerPC systems.',
    integrated: false,
  },
  'wasm-68k': {
    id: 'wasm-68k',
    label: 'WASM 68k',
    runtime: 'browser',
    description: 'Browser engine for 68k systems.',
    integrated: false,
  },
};

export function getEngine(id: EngineId): EngineDefinition {
  return engines[id];
}

export function isEngineIntegrated(id: EngineId): boolean {
  return engines[id].integrated;
}
