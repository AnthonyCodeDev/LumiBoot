import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useProxyStore } from '../../features/proxy/store';
import { clearProxySession, saveProxySession } from '../../features/proxy/persistence';
import { resolveProxyConfig } from '../../config/runtime';
import type { DownloadsManifest } from '../../config/downloads';
import type { HostPlatform } from '../../lib/platform';
import { NetworkProxyCard } from './NetworkProxyCard';
import { NetworkProxyDownload } from './NetworkProxyDownload';

function manifestWith(published: Record<string, string | null>): DownloadsManifest {
  const entry = (file: string, url: string | null) => ({
    file,
    url,
    size: url ? 10 : null,
    sha256: url ? 'sha' : null,
    published: url !== null,
  });
  return {
    version: '0.0.0',
    wispVersion: 1,
    generatedAt: null,
    platforms: {
      'windows-x64': entry('LumiBoot-Network-windows-amd64.exe', published['windows-x64'] ?? null),
      'windows-arm64': entry(
        'LumiBoot-Network-windows-arm64.exe',
        published['windows-arm64'] ?? null,
      ),
      'linux-x64': entry('LumiBoot-Network-linux-amd64.tar.gz', published['linux-x64'] ?? null),
      'linux-arm64': entry('LumiBoot-Network-linux-arm64.tar.gz', published['linux-arm64'] ?? null),
      macos: {
        ...entry('LumiBoot-Network-macos-universal.tar.gz', published['macos'] ?? null),
        signed: false,
        notarized: false,
      },
    },
  };
}

const WIN: HostPlatform = { os: 'windows', arch: 'x64', key: 'windows-x64' };
const PUBLISHED_WIN = manifestWith({ 'windows-x64': 'https://example.com/win.exe' });
const PROXY_URL = resolveProxyConfig().url;

/** Persiste une session d'appairage valide (non expirée) pour l'URL courante. */
function persistSession(): void {
  saveProxySession({
    token: 'tok',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    proxyUrl: PROXY_URL,
  });
}

// Actions du store remplacées par des espions : la carte ne déclenche alors
// aucun appel réseau (les tests pilotent directement l'état).
const refresh = vi.fn(async () => {});
const cancelPairing = vi.fn();
const startPairing = vi.fn(async () => {});
const revoke = vi.fn(async () => {});

beforeEach(() => {
  clearProxySession();
  refresh.mockClear();
  cancelPairing.mockClear();
  startPairing.mockClear();
  // Réinitialise l'implémentation éventuellement surchargée par un test.
  startPairing.mockImplementation(async () => {});
  revoke.mockClear();
  useProxyStore.setState({
    state: 'not-running',
    token: null,
    pairingId: null,
    userCode: null,
    error: null,
    refresh,
    cancelPairing,
    startPairing,
    revoke,
  });
});

afterEach(() => {
  clearProxySession();
});

describe('NetworkProxyCard', () => {
  it('affiche le titre, la description courte et le bouton « Appairer »', () => {
    render(<NetworkProxyCard platform={WIN} manifest={PUBLISHED_WIN} />);
    expect(screen.getByRole('heading', { name: 'Internet via votre connexion' })).toBeTruthy();
    expect(screen.getByText(/Faites profiter vos systèmes lancés/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Appairer' })).toBeTruthy();
  });

  it('cliquer « Appairer » lance startPairing', async () => {
    const user = userEvent.setup();
    render(<NetworkProxyCard platform={WIN} manifest={PUBLISHED_WIN} />);
    await user.click(screen.getByRole('button', { name: 'Appairer' }));
    expect(startPairing).toHaveBeenCalledTimes(1);
  });

  it('état connecting : libellé « Appairage… » et bouton désactivé', () => {
    useProxyStore.setState({ state: 'connecting' });
    render(<NetworkProxyCard platform={WIN} manifest={PUBLISHED_WIN} />);
    const button = screen.getByRole('button', { name: 'Appairage…' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Appairer' })).toBeNull();
  });

  it('état connected + token : « Connecté » et « Déconnecter », pas « Appairer »', () => {
    useProxyStore.setState({ state: 'connected', token: 'tok' });
    render(<NetworkProxyCard platform={WIN} manifest={PUBLISHED_WIN} />);
    expect(screen.getByText('Connecté')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Déconnecter' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Appairer' })).toBeNull();
    expect(screen.getByText('Votre connexion est partagée avec vos systèmes.')).toBeTruthy();
  });

  it('lien discret « Installer » présent quand une cible publiée existe', () => {
    render(<NetworkProxyCard platform={WIN} manifest={PUBLISHED_WIN} />);
    const link = screen.getByRole('link', { name: 'Installer' });
    expect(link.getAttribute('href')).toBe('https://example.com/win.exe');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('aucun lien « Installer » quand aucune cible n’est publiée', () => {
    render(<NetworkProxyCard platform={WIN} manifest={manifestWith({})} />);
    expect(screen.queryByRole('link', { name: 'Installer' })).toBeNull();
  });

  it.each(['not-installed', 'not-running', 'permission-required', 'incompatible'] as const)(
    'état passif « %s » sans session : aucune alerte/erreur affichée',
    (state) => {
      useProxyStore.setState({ state });
      render(<NetworkProxyCard platform={WIN} manifest={PUBLISHED_WIN} />);
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByRole('status')).toBeNull();
      expect(screen.queryByText(/Appairage impossible/)).toBeNull();
    },
  );

  it('sans session + state error : aucun message d’erreur ni d’alerte affiché', () => {
    useProxyStore.setState({
      state: 'error',
      error: 'Un long message technique du store qui ne doit pas être affiché.',
    });
    render(<NetworkProxyCard platform={WIN} manifest={PUBLISHED_WIN} />);
    // Aucun message d'erreur/alerte quand on n'est pas appairé.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    // Jamais le long message du store, ni l'ancien message alarmiste.
    expect(screen.queryByText(/long message technique/)).toBeNull();
    expect(screen.queryByText(/Le proxy n’a pas répondu/)).toBeNull();
    expect(screen.queryByText(/Appairage impossible/)).toBeNull();
  });

  it('session persistée + state error : message neutre « Vous êtes déjà appairé… », pas d’erreur', () => {
    persistSession();
    useProxyStore.setState({ state: 'error', error: 'proxy injoignable' });
    render(<NetworkProxyCard platform={WIN} manifest={PUBLISHED_WIN} />);
    expect(screen.getByRole('status').textContent).toBe(
      'Vous êtes déjà appairé. Relancez le proxy, ou cliquez sur le bouton ci-dessus pour lancer un nouvel appairage.',
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/Appairage impossible/)).toBeNull();
  });

  it('session persistée + state not-running : message neutre « Vous êtes déjà appairé… »', () => {
    persistSession();
    useProxyStore.setState({ state: 'not-running' });
    render(<NetworkProxyCard platform={WIN} manifest={PUBLISHED_WIN} />);
    expect(screen.getByRole('status').textContent).toMatch(/Vous êtes déjà appairé/);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('cliquer « Appairer » (passage en connecting) fait disparaître le message « déjà appairé »', async () => {
    const user = userEvent.setup();
    persistSession();
    useProxyStore.setState({ state: 'not-running' });
    // La vraie action passerait en 'connecting' : on simule ce basculement.
    startPairing.mockImplementation(async () => {
      useProxyStore.setState({ state: 'connecting' });
    });
    render(<NetworkProxyCard platform={WIN} manifest={PUBLISHED_WIN} />);
    expect(screen.getByRole('status').textContent).toMatch(/Vous êtes déjà appairé/);

    await user.click(screen.getByRole('button', { name: 'Appairer' }));

    expect(screen.queryByText(/Vous êtes déjà appairé/)).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: 'Appairage…' })).toBeTruthy();
  });

  it('état pairing-required avec code : courte ligne « En attente d’autorisation… »', () => {
    useProxyStore.setState({ state: 'pairing-required', userCode: 'ABCD-1234' });
    render(<NetworkProxyCard platform={WIN} manifest={PUBLISHED_WIN} />);
    expect(screen.getByText('En attente d’autorisation…')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('NetworkProxyDownload', () => {
  it('rend un lien « Installer » pour la plateforme détectée/injectée', () => {
    render(<NetworkProxyDownload platform={WIN} manifest={PUBLISHED_WIN} />);
    const link = screen.getByRole('link', { name: 'Installer' });
    expect(link.getAttribute('href')).toBe('https://example.com/win.exe');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('ne rend rien si aucune cible publiée ne correspond', () => {
    const { container } = render(
      <NetworkProxyDownload platform={WIN} manifest={manifestWith({})} />,
    );
    expect(container.querySelector('a')).toBeNull();
  });

  it('toggle « voir toutes les versions » : masqué par défaut, déplie toutes les cibles, puis replie', async () => {
    const user = userEvent.setup();
    render(<NetworkProxyDownload platform={WIN} manifest={PUBLISHED_WIN} />);

    const toggle = screen.getByRole('button', { name: 'voir toutes les versions' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('list')).toBeNull();

    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toBe('masquer les versions');

    // Les 5 plateformes sont listées.
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    // Cible publiée : lien cliquable.
    const winLink = screen.getByRole('link', { name: 'Windows x64' });
    expect(winLink.getAttribute('href')).toBe('https://example.com/win.exe');
    // Cibles non publiées : « Bientôt disponible ».
    expect(screen.getByText(/Windows ARM64 · Bientôt disponible/)).toBeTruthy();
    expect(screen.getByText(/macOS · Bientôt disponible/)).toBeTruthy();

    await user.click(toggle);
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByRole('button', { name: 'voir toutes les versions' })).toBeTruthy();
  });
});
