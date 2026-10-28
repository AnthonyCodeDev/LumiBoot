import type { OSDefinition } from '@lumiboot/contracts';
import { getPrimaryLaunchProfile } from './labels';

/**
 * True when the session's primary surface is the serial console, i.e. a CLI
 * guest (`displayMode: 'text'`) whose only output is on ttyS0. A graphical or
 * absent `displayMode` keeps the VGA/framebuffer screen as the primary view and
 * the serial logs collapsed.
 *
 * This is an explicit catalog fact, never a guess from the display name.
 */
export function opensSerialConsoleByDefault(system: Pick<OSDefinition, 'launchProfiles'>): boolean {
  return getPrimaryLaunchProfile(system).displayMode === 'text';
}
