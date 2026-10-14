import type { Architecture, EngineId, ExecutionMode, Availability } from '@lumiboot/contracts';

export interface SystemImageDefinition {
    readonly id: string;
    readonly familyId: string;
    readonly architecture: Architecture;
    readonly engineId: EngineId;
    readonly executionMode: ExecutionMode;
    readonly availability: Availability;
    readonly minMemoryMiB: number;
    readonly imageRef?: string;
    readonly requirements: readonly string[];
    readonly licenseNotes?: string;
    readonly integrationNote: string;
}

export const images = [
    {
        id: 'debian-12-i386-image',
        familyId: 'debian',
        architecture: 'i386',
        executionMode: 'browser',
        engineId: 'v86',
        availability: 'planned',
        minMemoryMiB: 128,
        requirements: ['Navigateur moderne', 'WebAssembly', 'Mémoire suffisante'],
        integrationNote: "Premier système du MVP. L'image Linux et le moteur v86 arrivent en premier lot.",
    },
    {
        id: 'ubuntu-18-i386-image',
        familyId: 'ubuntu',
        architecture: 'i386',
        executionMode: 'browser',
        engineId: 'v86',
        availability: 'planned',
        minMemoryMiB: 256,
        requirements: ['Image i386 compatible', 'Tests de démarrage'],
        integrationNote:
            'Version ancienne retenue pour une compatibilité v86 plausible. Image à brancher au lot Debian.',
    },
    {
        id: 'fedora-workstation-image',
        familyId: 'fedora',
        architecture: 'x86_64',
        executionMode: 'browser',
        engineId: 'wasm-x86_64',
        availability: 'planned',
        minMemoryMiB: 4096,
        requirements: ['WebAssembly', 'Mémoire suffisante', 'Architecture x86-64'],
        integrationNote: 'Moteur navigateur à développer pour les systèmes x86-64.',
    },
    {
        id: 'mint-x64-image',
        familyId: 'mint',
        architecture: 'x86_64',
        executionMode: 'browser',
        engineId: 'wasm-x86_64',
        availability: 'planned',
        minMemoryMiB: 4096,
        requirements: ['WebAssembly', 'Mémoire suffisante', 'Architecture x86-64'],
        integrationNote: 'Moteur navigateur à développer pour les systèmes x86-64.',
    },
    {
        id: 'windows-7-x86-image',
        familyId: 'windows',
        architecture: 'i386',
        executionMode: 'browser',
        engineId: 'wasm-x86',
        availability: 'planned',
        minMemoryMiB: 2048,
        requirements: ['WebAssembly', 'Licence et média autorisés', 'Mémoire suffisante'],
        licenseNotes: 'Média et licence fournis par l’utilisateur. Aucune redistribution.',
        integrationNote: 'Moteur navigateur à développer pour les systèmes x86 32 bits.',
    },
    {
        id: 'windows-10-x64-image',
        familyId: 'windows',
        architecture: 'x86_64',
        executionMode: 'browser',
        engineId: 'wasm-x86_64',
        availability: 'planned',
        minMemoryMiB: 4096,
        requirements: ['WebAssembly', 'Licence Windows valide', 'Mémoire suffisante'],
        licenseNotes: 'Licence Windows requise. Aucune ISO propriétaire fournie.',
        integrationNote: 'Moteur navigateur à développer pour les systèmes x86-64.',
    },
    {
        id: 'windows-11-x64-image',
        familyId: 'windows',
        architecture: 'x86_64',
        executionMode: 'browser',
        engineId: 'wasm-x86_64',
        availability: 'planned',
        minMemoryMiB: 4096,
        requirements: ['WebAssembly', 'TPM virtuel selon configuration', 'Licence Windows'],
        licenseNotes: 'Licence Windows requise. Aucune ISO propriétaire fournie.',
        integrationNote: 'Moteur navigateur à développer pour les systèmes x86-64.',
    },
    {
        id: 'macos-sequoia-image',
        familyId: 'macos',
        architecture: 'arm64',
        executionMode: 'browser',
        engineId: 'wasm-arm',
        availability: 'planned',
        minMemoryMiB: 8192,
        requirements: ['WebAssembly', 'Mémoire suffisante', 'Conformité à la licence macOS'],
        licenseNotes: 'Virtualisation macOS soumise à la licence Apple et au matériel compatible.',
        integrationNote: 'Moteur navigateur à développer pour les systèmes ARM.',
    },
] as const satisfies readonly SystemImageDefinition[];