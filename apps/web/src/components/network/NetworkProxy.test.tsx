import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useProxyStore } from '../../features/proxy/store';
import type { DownloadsManifest } from '../../config/downloads';
import { NetworkProxyCard } from './NetworkProxyCard';
import { NetworkProxyDownload } from './NetworkProxyDownload';
import { NetworkProxyStatus } from './NetworkProxyStatus';

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

const PUBLISHED_WIN = manifestWith({ 'windows-x64': 'https://example.com/win.exe' });

function stubHealth(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => body,
      }) as unknown as Response) as typeof fetch,
  );
}

beforeEach(() => {
  useProxyStore.setState({
    state: 'not-running',
    token: null,
    pairingId: null,
    userCode: null,
    error: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NetworkProxyStatus', () => {
  it('affiche l’état arrêté avec une action Réessayer', async () => {
    vi.stubGlobal('fetch', (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch);
    useProxyStore.setState({ state: 'not-running', token: null });
    render(<NetworkProxyStatus />);
    expect(await screen.findByText('Proxy réseau local arrêté')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeTruthy();
  });

  it('pairing-required sans userCode : « Lancer l’appairage » seul, pas « Connecter »', async () => {
    stubHealth({ status: 'ok', version: '0.1.0', wispVersion: 1 });
    useProxyStore.setState({ state: 'pairing-required', token: null, userCode: null });
    render(<NetworkProxyStatus />);
    expect(await screen.findByText('En attente d’autorisation')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connecter' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Lancer l’appairage' })).toBeTruthy();
  });

  it('pairing-required avec userCode : code affiché, « En attente d’autorisation… », aucun bouton Connecter', async () => {
    stubHealth({ status: 'ok', version: '0.1.0', wispVersion: 1 });
    useProxyStore.setState({ state: 'pairing-required', token: null, userCode: 'ABCD-1234' });
    render(<NetworkProxyStatus />);
    expect(await screen.findByText('En attente d’autorisation')).toBeTruthy();
    expect(screen.getByText('ABCD-1234')).toBeTruthy();
    expect(screen.getByText(/En attente d’autorisation…/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connecter' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Lancer l’appairage' })).toBeNull();
  });

  it('état connected + token : « Proxy réseau local actif » et Révocable', async () => {
    stubHealth({ status: 'ok', version: '0.1.0', wispVersion: 1 });
    useProxyStore.setState({ state: 'connected', token: 'tok' });
    render(<NetworkProxyStatus />);
    expect(await screen.findByText('Proxy réseau local actif')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Révoquer' })).toBeTruthy();
  });

  it('état error : proposition de relancer l’appairage', async () => {
    stubHealth({ status: 'ok', version: '0.1.0', wispVersion: 1 });
    useProxyStore.setState({ state: 'pairing-required', token: null, userCode: null });
    render(<NetworkProxyStatus />);
    // Laisse le refresh de montage se stabiliser.
    await screen.findByText('En attente d’autorisation');
    await act(async () => {
      useProxyStore.setState({
        state: 'error',
        error: 'Accès refusé depuis la console du proxy.',
      });
    });
    expect(await screen.findByText('Accès refusé depuis la console du proxy.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Relancer l’appairage' })).toBeTruthy();
  });
});

describe('NetworkProxyDownload', () => {
  it('bouton auto selon la plateforme détectée', () => {
    render(
      <NetworkProxyDownload
        platform={{ os: 'windows', arch: 'x64', key: 'windows-x64' }}
        manifest={PUBLISHED_WIN}
      />,
    );
    expect(screen.getByRole('button', { name: 'Télécharger pour Windows' })).toBeTruthy();
  });

  it('aucun lien si non publié : « Bientôt disponible » et cible désactivée', async () => {
    const user = userEvent.setup();
    const empty = manifestWith({});
    render(
      <NetworkProxyDownload
        platform={{ os: 'windows', arch: 'x64', key: 'windows-x64' }}
        manifest={empty}
      />,
    );
    expect(screen.getByText(/Bientôt disponible/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Autres plateformes' }));
    expect(screen.getByText(/Windows x64.*Bientôt disponible/)).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('macOS non signée : avertissement explicite quand macOS est la plateforme', () => {
    const macos = manifestWith({ macos: 'https://example.com/mac.tar.gz' });
    render(
      <NetworkProxyDownload
        platform={{ os: 'macos', arch: 'unknown', key: 'macos' }}
        manifest={macos}
      />,
    );
    expect(screen.getByText(/non signée/)).toBeTruthy();
  });

  it('Windows sans dépliage : aucun avertissement macOS', () => {
    const both = manifestWith({
      'windows-x64': 'https://example.com/win.exe',
      macos: 'https://example.com/mac.tar.gz',
    });
    render(
      <NetworkProxyDownload
        platform={{ os: 'windows', arch: 'x64', key: 'windows-x64' }}
        manifest={both}
      />,
    );
    expect(screen.queryByText(/non signée/)).toBeNull();
  });

  it('Windows + « Autres plateformes » : avertissement macOS et entrée annotée (non signé)', async () => {
    const user = userEvent.setup();
    const both = manifestWith({
      'windows-x64': 'https://example.com/win.exe',
      macos: 'https://example.com/mac.tar.gz',
    });
    render(
      <NetworkProxyDownload
        platform={{ os: 'windows', arch: 'x64', key: 'windows-x64' }}
        manifest={both}
      />,
    );
    expect(screen.queryByText(/non signée/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Autres plateformes' }));
    expect(screen.getByText(/non signée/)).toBeTruthy();
    expect(screen.getByText(/macOS \(universel\) \(non signé\)/)).toBeTruthy();
  });
});

describe('NetworkProxyCard', () => {
  it('titre et description imposés, étapes visibles quand non connecté', async () => {
    stubHealth({ status: 'ok', version: '0.1.0', wispVersion: 1 });
    useProxyStore.setState({ state: 'pairing-required', token: null });
    render(
      <NetworkProxyCard
        platform={{ os: 'windows', arch: 'x64', key: 'windows-x64' }}
        manifest={PUBLISHED_WIN}
      />,
    );
    expect(await screen.findByText('Internet via votre connexion')).toBeTruthy();
    expect(screen.getByText(/utiliser directement votre connexion Internet/)).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText(/Téléchargez le proxy réseau local/)).toBeTruthy();
    });
  });

  it('état connecté : masque les instructions d’installation', async () => {
    stubHealth({ status: 'ok', version: '0.1.0', wispVersion: 1 });
    useProxyStore.setState({ state: 'connected', token: 'tok' });
    render(
      <NetworkProxyCard
        platform={{ os: 'windows', arch: 'x64', key: 'windows-x64' }}
        manifest={PUBLISHED_WIN}
      />,
    );
    await waitFor(() => {
      expect(screen.queryByText(/Téléchargez le proxy réseau local/)).toBeNull();
    });
    expect(screen.getByText('Proxy réseau local actif')).toBeTruthy();
  });
});
