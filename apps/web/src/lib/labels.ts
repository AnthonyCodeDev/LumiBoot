import type { Architecture, Availability, EngineId, ExecutionMode, OSFamily } from '@lumiboot/contracts';

export const familyLabels: Record<OSFamily, string> = {
  linux: 'Linux',
  windows: 'Windows',
  macos: 'macOS',
};

export const engineLabels: Record<EngineId, string> = {
  v86: 'v86 / WebAssembly',
  'wasm-x86': 'WASM x86',
  'wasm-x86_64': 'WASM x86-64',
  'wasm-arm': 'WASM ARM',
  'wasm-powerpc': 'WASM PowerPC',
  'wasm-68k': 'WASM 68k',
};

export const executionLabels: Record<ExecutionMode, string> = {
  browser: 'Dans le navigateur',
};

export const availabilityLabels: Record<Availability, string> = {
  planned: 'En préparation',
  experimental: 'Expérimental',
  ready: 'Disponible',
  unavailable: 'Indisponible',
};

export const executionShortLabel = (mode: ExecutionMode): string =>
  mode === 'browser' ? 'Local · WASM' : 'Local · WASM';

export const architectureLabels: Record<Architecture, string> = {
  i386: 'i386',
  x86: 'x86',
  x86_64: 'x64',
  arm: 'ARM',
  arm64: 'arm64',
  powerpc: 'PowerPC',
  m68k: '68k',
};
