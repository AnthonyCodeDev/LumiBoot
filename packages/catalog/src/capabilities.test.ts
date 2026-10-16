import { describe, expect, it } from 'vitest';
import { getCompatibility, type BrowserCapabilities } from './capabilities';
import { getSystemById } from './systems';

const CAPS: BrowserCapabilities = {
  webAssembly: true,
  webAssemblyStreaming: true,
  sharedArrayBuffer: true,
  crossOriginIsolated: true,
};

function system(id: string) {
  const found = getSystemById(id);
  if (!found) throw new Error(`système introuvable : ${id}`);
  return found;
}

describe('getCompatibility', () => {
  it('déclare Windows 7 Professionnel compatible navigateur quand WebAssembly est présent', () => {
    const result = getCompatibility(system('windows-7-pro-sp1-x86'), CAPS);
    expect(result).toEqual({ supported: true, reasons: [] });
  });

  it('refuse Windows 7 Professionnel sans WebAssembly (émulation navigateur impossible)', () => {
    const result = getCompatibility(system('windows-7-pro-sp1-x86'), {
      ...CAPS,
      webAssembly: false,
    });
    expect(result.supported).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/WebAssembly/);
  });

  it('refuse un système dont le moteur n’est pas intégré (Fedora x64)', () => {
    const result = getCompatibility(system('fedora-workstation'), CAPS);
    expect(result.supported).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/moteur/i);
  });
});
