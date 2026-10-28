import { describe, expect, it } from 'vitest';
import type { Architecture } from '@lumiboot/contracts';
import { architectureSummary, cleanVersionLabel, systemVersionLabel } from './labels';

const architecture = (value: Architecture): { architecture: Architecture } => ({
  architecture: value,
});

describe('architecture presentation', () => {
  it('normalizes legacy x86 labels and removes experimental from the version', () => {
    expect(cleanVersionLabel('3.24 · x86-64')).toBe('3.24');
    expect(cleanVersionLabel('x86 (32-bit)')).toBe('');
    expect(cleanVersionLabel('x64 · experimental')).toBe('');
  });

  it('deduplicates a single architecture across variants', () => {
    expect(
      architectureSummary([architecture('i386'), architecture('i386'), architecture('x86')]),
    ).toBe('32 bits');
  });

  it('synthesizes both architectures for a mixed parent group', () => {
    expect(architectureSummary([architecture('i386'), architecture('x86_64')])).toBe(
      '32 bits · 64 bits',
    );
  });

  it('combines the clean release with the canonical architecture', () => {
    expect(systemVersionLabel({ versionLabel: '3.24 · x86-64', architecture: 'x86_64' })).toBe(
      '3.24 · 64 bits',
    );
  });
});
