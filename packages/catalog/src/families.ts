export interface OSFamilyDefinition {
  readonly id: string;
  readonly family: 'linux' | 'windows' | 'macos' | 'custom';
  readonly displayName: string;
  readonly iconUrl: string;
  readonly accent: string;
  readonly accentRgb: string;
}

export const families = [
  {
    id: 'debian',
    family: 'linux',
    displayName: 'Debian',
    iconUrl: '/icons/os/debian.svg',
    accent: '#ec4264',
    accentRgb: '236,66,100',
  },
  {
    id: 'ubuntu',
    family: 'linux',
    displayName: 'Ubuntu',
    iconUrl: '/icons/os/ubuntu.svg',
    accent: '#f48748',
    accentRgb: '244,135,72',
  },
  {
    id: 'fedora',
    family: 'linux',
    displayName: 'Fedora',
    iconUrl: '/icons/os/fedora.svg',
    accent: '#7297f3',
    accentRgb: '114,151,243',
  },
  {
    id: 'mint',
    family: 'linux',
    displayName: 'Linux Mint',
    iconUrl: '/icons/os/mint.svg',
    accent: '#66c69d',
    accentRgb: '102,198,157',
  },
  {
    id: 'windows',
    family: 'windows',
    displayName: 'Windows',
    iconUrl: '/icons/os/windows.svg',
    accent: '#8eb8ff',
    accentRgb: '142,184,255',
  },
  {
    id: 'macos',
    family: 'macos',
    displayName: 'macOS',
    iconUrl: '/icons/os/macos.svg',
    accent: '#c6b9ff',
    accentRgb: '198,185,255',
  },
  {
    // Generic entry: any disk media the user owns, no brand.
    id: 'custom',
    family: 'custom',
    displayName: 'Custom',
    iconUrl: '/icons/os/custom.svg',
    accent: '#9fb0c9',
    accentRgb: '159,176,201',
  },
] as const satisfies readonly OSFamilyDefinition[];
