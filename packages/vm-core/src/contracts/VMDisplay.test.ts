import { describe, expect, it } from 'vitest';
import {
  STANDARD_VM_DISPLAY,
  VM_DISPLAY_ATTRIBUTE,
  VM_DISPLAY_ROLES,
  vmDisplaySelector,
} from './VMDisplay';
import { STANDARD_VM_INPUT } from './VMInput';

describe('VMDisplay display contract', () => {
  it('exposes provider-agnostic selectors', () => {
    expect(vmDisplaySelector(VM_DISPLAY_ROLES.screen)).toBe('[data-vm-display="screen"]');
    expect(vmDisplaySelector(VM_DISPLAY_ROLES.text)).toBe('[data-vm-display="text"]');
    expect(STANDARD_VM_DISPLAY.screenSelector).toBe('[data-vm-display="screen"]');
    expect(STANDARD_VM_DISPLAY.textSelector).toBe('[data-vm-display="text"]');
    expect(VM_DISPLAY_ATTRIBUTE).toBe('data-vm-display');
  });

  it('targets no engine in hard code (provider independence)', () => {
    expect(STANDARD_VM_DISPLAY.screenSelector).not.toContain('v86');
    expect(STANDARD_VM_DISPLAY.textSelector).not.toContain('v86');
  });
});

describe('VMInput input contract', () => {
  it('describes an explicit capture returned by Escape and by blur', () => {
    expect(STANDARD_VM_INPUT).toEqual({
      pointer: 'capture',
      releaseOnEscape: true,
      releaseOnBlur: true,
    });
  });
});
