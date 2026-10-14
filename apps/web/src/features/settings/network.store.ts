import { create } from 'zustand';
import {
  defaultNetworkProfile,
  normalizeNetworkProfile,
  validateRelayUrl,
  type NetworkMode,
  type NetworkProfile,
} from '@lumiboot/vm-network';

/** Clé de persistance versionnée. Aucune donnée secrète n'y est jamais écrite. */
export const NETWORK_PROFILE_STORAGE_KEY = 'lumiboot:network-profile:v1';

export interface NetworkState {
  profile: NetworkProfile;
  setMode: (mode: NetworkMode) => void;
  setRelayUrl: (url: string) => void;
  reset: () => void;
}

/**
 * Accès localStorage tolérant aux pannes : navigation privée, quota, SSR…
 * La persistance ne doit jamais faire échouer le rendu.
 */
function getStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Relit le profil stocké en tolérant un contenu absent ou corrompu. */
function readStoredProfile(): NetworkProfile {
  const storage = getStorage();
  if (!storage) return defaultNetworkProfile;
  try {
    const raw = storage.getItem(NETWORK_PROFILE_STORAGE_KEY);
    if (raw === null) return defaultNetworkProfile;
    return normalizeNetworkProfile(JSON.parse(raw));
  } catch {
    return defaultNetworkProfile;
  }
}

function persistProfile(profile: NetworkProfile): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(NETWORK_PROFILE_STORAGE_KEY, JSON.stringify(profile));
  } catch {
    /* quota dépassé / stockage refusé : on ignore silencieusement. */
  }
}

function clearStoredProfile(): void {
  const storage = getStorage();
  try {
    storage?.removeItem(NETWORK_PROFILE_STORAGE_KEY);
  } catch {
    /* stockage indisponible : rien à effacer. */
  }
}

export const useNetworkStore = create<NetworkState>((set, get) => ({
  profile: readStoredProfile(),
  setMode: (mode) => {
    const current = get().profile;
    // `relayUrl` n'est conservé que pour `user-relay` : le profil reste net.
    const relayUrl = mode === 'user-relay' ? current.relayUrl : undefined;
    const profile = normalizeNetworkProfile(relayUrl ? { mode, relayUrl } : { mode });
    persistProfile(profile);
    set({ profile });
  },
  setRelayUrl: (url) => {
    // Aucune adresse non validée n'est stockée : `validateRelayUrl` interdit
    // notamment les identifiants (userinfo) et les schémas non chiffrés.
    const validation = validateRelayUrl(url);
    if (!validation.ok || validation.url === undefined) return;
    const profile = normalizeNetworkProfile({ mode: 'user-relay', relayUrl: validation.url });
    persistProfile(profile);
    set({ profile });
  },
  reset: () => {
    clearStoredProfile();
    set({ profile: defaultNetworkProfile });
  },
}));
