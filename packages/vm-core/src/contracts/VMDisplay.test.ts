import { describe, expect, it } from 'vitest';
import {
  STANDARD_VM_DISPLAY,
  VM_DISPLAY_ATTRIBUTE,
  VM_DISPLAY_ROLES,
  vmDisplaySelector,
} from './VMDisplay';
import { STANDARD_VM_INPUT } from './VMInput';

describe('contrat d’affichage VMDisplay', () => {
  it('expose des sélecteurs provider-agnostiques', () => {
    expect(vmDisplaySelector(VM_DISPLAY_ROLES.screen)).toBe('[data-vm-display="screen"]');
    expect(vmDisplaySelector(VM_DISPLAY_ROLES.text)).toBe('[data-vm-display="text"]');
    expect(STANDARD_VM_DISPLAY.screenSelector).toBe('[data-vm-display="screen"]');
    expect(STANDARD_VM_DISPLAY.textSelector).toBe('[data-vm-display="text"]');
    expect(VM_DISPLAY_ATTRIBUTE).toBe('data-vm-display');
  });

  it('ne cible aucun moteur en dur (indépendance provider)', () => {
    expect(STANDARD_VM_DISPLAY.screenSelector).not.toContain('v86');
    expect(STANDARD_VM_DISPLAY.textSelector).not.toContain('v86');
  });
});

describe('contrat d’entrée VMInput', () => {
  it('décrit une capture explicite restituée par Échap et par blur', () => {
    expect(STANDARD_VM_INPUT).toEqual({
      pointer: 'capture',
      releaseOnEscape: true,
      releaseOnBlur: true,
    });
  });
});
