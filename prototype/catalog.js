/**
 * Catalogue de démonstration. Ne jamais convertir un statut "planned" en
 * "ready" sans un démarrage réel validé sur le moteur correspondant.
 */
export const systems = [
    {
        id: 'debian-12-i386', family: 'linux', name: 'Debian', version: '12 Bookworm', arch: 'i386',
        engine: 'v86', execution: 'browser', status: 'planned', featured: true,
        icon: 'debian.svg', accent: '#ec4264', accentRGB: '236,66,100',
        description: 'Une distribution Linux stable, flexible et idéale pour découvrir un véritable système d’exploitation en navigateur.',
        requirements: 'Navigateur moderne, WebAssembly, mémoire suffisante.',
        note: 'Premier système du MVP. L’image Linux et le moteur v86 ne sont pas encore intégrés.'
    },
    {
        id: 'ubuntu-18-i386', family: 'linux', name: 'Ubuntu', version: '18.04 LTS', arch: 'i386',
        engine: 'v86', execution: 'browser', status: 'planned',
        icon: 'ubuntu.svg', accent: '#f48748', accentRGB: '244,135,72',
        description: 'Une version 32 bits historique d’Ubuntu envisageable avec un émulateur x86 en navigateur.',
        requirements: 'Image i386 compatible et tests de démarrage.',
        note: 'Version ancienne retenue pour une compatibilité v86 plausible. Aucune image fournie.'
    },
    {
        id: 'fedora-workstation', family: 'linux', name: 'Fedora', version: 'Workstation · x64', arch: 'x86_64',
        engine: 'wasm-x86_64', execution: 'browser', status: 'planned',
        icon: 'fedora.svg', accent: '#7297f3', accentRGB: '114,151,243',
        description: 'Un environnement Linux de bureau moderne prévu pour une exécution navigateur locale.',
        requirements: 'Ressources CPU/RAM suffisantes, navigateur moderne, WebAssembly.',
        note: 'Prévu pour un moteur local compatible. Non inclus dans le MVP.'
    },
    {
        id: 'mint-x64', family: 'linux', name: 'Linux Mint', version: 'Cinnamon · x64', arch: 'x86_64',
        engine: 'wasm-x86_64', execution: 'browser', status: 'planned',
        icon: 'mint.svg', accent: '#66c69d', accentRGB: '102,198,157',
        description: 'Un bureau Linux classique et accessible, à lancer localement dans le navigateur.',
        requirements: 'Navigateur moderne, WebAssembly, mémoire suffisante.',
        note: 'Environnement local futur. Aucune image système n’est distribuée.'
    },
    {
        id: 'windows-7-x86', family: 'windows', name: 'Windows 7', version: 'Édition x86', arch: 'i386',
        engine: 'wasm-x86_64', execution: 'browser', status: 'planned',
        icon: 'windows.svg', accent: '#8eb8ff', accentRGB: '142,184,255',
        description: 'Une session Windows classique dans le navigateur, sous réserve d’une licence valide et d’un moteur compatible.',
        requirements: 'Licence et média autorisés, navigateur compatible.',
        note: 'Un essai 32 bits local reste expérimental. Le catalogue ne promet pas de compatibilité locale.'
    },
    {
        id: 'windows-10-x64', family: 'windows', name: 'Windows 10', version: '64 bits', arch: 'x86_64',
        engine: 'wasm-x86_64', execution: 'browser', status: 'planned',
        icon: 'windows.svg', accent: '#75afea', accentRGB: '117,175,234',
        description: 'Une version moderne de Windows pensée pour une exécution locale dans le navigateur.',
        requirements: 'Licence Windows valide, navigateur compatible et mémoire suffisante.',
        note: 'Ne peut pas démarrer comme machine x64 avec v86. À prévoir dans une intégration locale ultérieure.'
    },
    {
        id: 'windows-11-x64', family: 'windows', name: 'Windows 11', version: '64 bits', arch: 'x86_64',
        engine: 'wasm-arm', execution: 'browser', status: 'planned',
        icon: 'windows.svg', accent: '#7bb9ff', accentRGB: '123,185,255',
        description: 'Une machine virtuelle Windows moderne pensée pour une exécution locale dans le navigateur.',
        requirements: 'Navigateur compatible, licence Windows et mémoire suffisante.',
        note: 'Windows 11 ne fonctionne pas dans v86. Une intégration locale dédiée sera nécessaire.'
    },
    {
        id: 'macos-sequoia', family: 'macos', name: 'macOS', version: 'Sequoia · Apple Silicon', arch: 'arm64',
        engine: 'wasm-arm', execution: 'browser', status: 'planned',
        icon: 'macos.svg', accent: '#c6b9ff', accentRGB: '198,185,255',
        description: 'Une session macOS pensée pour une exécution locale compatible navigateur.',
        requirements: 'Matériel Apple, version compatible et conformité à la licence macOS.',
        note: 'Le support multi-version doit être étudié une par une. Non disponible dans le MVP.'
    }
];

export const getSystemById = (id) => systems.find((system) => system.id === id) ?? null;
