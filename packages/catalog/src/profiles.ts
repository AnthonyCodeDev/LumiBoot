import type { Availability } from '@lumiboot/contracts';

export interface LaunchProfileDefinition {
    readonly id: string;
    readonly familyId: string;
    readonly imageId: string;
    readonly slug: string;
    readonly displayName: string;
    readonly versionLabel: string;
    readonly description: string;
    readonly availability: Availability;
    readonly featured?: boolean;
}

export const launchProfiles = [
    {
        id: 'debian-12-i386',
        familyId: 'debian',
        imageId: 'debian-12-i386-image',
        slug: 'debian-12-i386',
        displayName: 'Debian',
        versionLabel: '12 Bookworm',
        availability: 'planned',
        featured: true,
        description:
            "Une distribution Linux stable, flexible et idéale pour découvrir un véritable système d'exploitation en navigateur.",
    },
    {
        id: 'ubuntu-18-i386',
        familyId: 'ubuntu',
        imageId: 'ubuntu-18-i386-image',
        slug: 'ubuntu-18-i386',
        displayName: 'Ubuntu',
        versionLabel: '18.04 LTS',
        availability: 'planned',
        description:
            'Une version 32 bits historique d’Ubuntu envisageable avec un émulateur x86 en navigateur.',
    },
    {
        id: 'fedora-workstation',
        familyId: 'fedora',
        imageId: 'fedora-workstation-image',
        slug: 'fedora-workstation',
        displayName: 'Fedora',
        versionLabel: 'Workstation · x64',
        availability: 'planned',
        description:
            'Un environnement Linux de bureau moderne prévu pour un moteur navigateur adapté.',
    },
    {
        id: 'mint-x64',
        familyId: 'mint',
        imageId: 'mint-x64-image',
        slug: 'mint-x64',
        displayName: 'Linux Mint',
        versionLabel: 'Cinnamon · x64',
        availability: 'planned',
        description: 'Un bureau Linux classique et accessible, à lancer dans le navigateur.',
    },
    {
        id: 'windows-7-x86',
        familyId: 'windows',
        imageId: 'windows-7-x86-image',
        slug: 'windows-7-x86',
        displayName: 'Windows 7',
        versionLabel: 'Édition x86',
        availability: 'planned',
        description:
            'Une session Windows classique dans le navigateur, sous réserve d’une licence valide et d’un moteur compatible.',
    },
    {
        id: 'windows-10-x64',
        familyId: 'windows',
        imageId: 'windows-10-x64-image',
        slug: 'windows-10-x64',
        displayName: 'Windows 10',
        versionLabel: '64 bits',
        availability: 'planned',
        description:
            'Une version moderne de Windows pensée pour un moteur navigateur adapté.',
    },
    {
        id: 'windows-11-x64',
        familyId: 'windows',
        imageId: 'windows-11-x64-image',
        slug: 'windows-11-x64',
        displayName: 'Windows 11',
        versionLabel: '64 bits',
        availability: 'planned',
        description:
            'Une machine virtuelle Windows moderne pensée pour une exécution locale dans le navigateur.',
    },
    {
        id: 'macos-sequoia',
        familyId: 'macos',
        imageId: 'macos-sequoia-image',
        slug: 'macos-sequoia',
        displayName: 'macOS',
        versionLabel: 'Sequoia · Apple Silicon',
        availability: 'planned',
        description:
            'Une session macOS pensée pour un futur moteur navigateur compatible ARM.',
    },
] as const satisfies readonly LaunchProfileDefinition[];