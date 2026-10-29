export const VM_DISPLAY_ATTRIBUTE = 'data-vm-display';

export const VM_DISPLAY_ROLES = {
  screen: 'screen',
  text: 'text',
} as const;

export type VMDisplayRole = (typeof VM_DISPLAY_ROLES)[keyof typeof VM_DISPLAY_ROLES];

export function vmDisplaySelector(role: VMDisplayRole): string {
  return `[${VM_DISPLAY_ATTRIBUTE}="${role}"]`;
}

export interface VMDisplay {
  readonly screenSelector: string;
  readonly textSelector: string;
}

export const STANDARD_VM_DISPLAY: VMDisplay = {
  screenSelector: vmDisplaySelector(VM_DISPLAY_ROLES.screen),
  textSelector: vmDisplaySelector(VM_DISPLAY_ROLES.text),
};
