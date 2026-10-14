import { describe, expect, it } from 'vitest';
import { getEffectiveAvailability, type SystemAvailabilityFacts } from './availability';
import { getSystemById } from './systems';
import { isEngineIntegrated } from './engines';

const allFacts: SystemAvailabilityFacts = {
  hasImage: true,
  hasCompatibleProfile: true,
  engineIntegrated: true,
  validated: true,
};

describe('getEffectiveAvailability', () => {
  it('marque ready uniquement lorsque les quatre conditions sont réunies', () => {
    expect(getEffectiveAvailability(allFacts)).toBe('ready');
  });

  it('ne rend pas disponible un système sans image', () => {
    expect(getEffectiveAvailability({ ...allFacts, hasImage: false })).toBe('planned');
  });

  it('ne rend pas disponible un système avec image mais moteur non intégré', () => {
    expect(getEffectiveAvailability({ ...allFacts, engineIntegrated: false })).toBe('planned');
  });

  it('ne rend pas disponible un système sans profil compatible', () => {
    expect(getEffectiveAvailability({ ...allFacts, hasCompatibleProfile: false })).toBe('planned');
  });

  it('ne rend pas disponible un système non validé', () => {
    expect(getEffectiveAvailability({ ...allFacts, validated: false })).toBe('planned');
  });

  it('rétrograde un ready déclaré mais non prouvé', () => {
    expect(getEffectiveAvailability({ ...allFacts, hasImage: false, declared: 'ready' })).toBe(
      'planned',
    );
  });
});

describe('catalogue : disponibilité effective cohérente', () => {
  it('marque Debian ready (image + moteur v86 intégré + boot validé)', () => {
    const debian = getSystemById('debian-12-i386');
    const profile = debian?.launchProfiles[0];
    expect(debian?.imageRef).toBeDefined();
    expect(profile && isEngineIntegrated(profile.engineId)).toBe(true);
    expect(debian?.availability).toBe('ready');
  });

  it('garde les autres systèmes à planned', () => {
    expect(getSystemById('ubuntu-18-i386')?.availability).toBe('planned');
    expect(getSystemById('fedora-workstation')?.availability).toBe('planned');
    expect(getSystemById('macos-sequoia')?.availability).toBe('planned');
  });

  it('ne rend pas disponible un système dont le moteur n’est pas intégré', () => {
    const fedora = getSystemById('fedora-workstation');
    const profile = fedora?.launchProfiles[0];
    expect(profile && isEngineIntegrated(profile.engineId)).toBe(false);
    expect(fedora?.availability).not.toBe('ready');
  });

  it('ne rend pas disponible un système sans image référencée', () => {
    const ubuntu = getSystemById('ubuntu-18-i386');
    expect(ubuntu?.imageRef).toBeUndefined();
    expect(ubuntu?.availability).not.toBe('ready');
  });
});
