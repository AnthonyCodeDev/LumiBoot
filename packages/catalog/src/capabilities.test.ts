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
  if (!found) throw new Error(`system not found: ${id}`);
  return found;
}

describe('getCompatibility', () => {
  it('declares Windows 7 Professional browser-compatible when WebAssembly is present', () => {
    const result = getCompatibility(system('windows-7-pro-sp1-x86'), CAPS);
    expect(result).toEqual({ supported: true, reasons: [] });
  });

  it('rejects Windows 7 Professional without WebAssembly (browser emulation impossible)', () => {
    const result = getCompatibility(system('windows-7-pro-sp1-x86'), {
      ...CAPS,
      webAssembly: false,
    });
    expect(result.supported).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/WebAssembly/);
  });

  it('rejects a system whose engine is not integrated (macOS Sequoia ARM)', () => {
    const result = getCompatibility(system('macos-sequoia'), CAPS);
    expect(result.supported).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/engine/i);
  });
});
