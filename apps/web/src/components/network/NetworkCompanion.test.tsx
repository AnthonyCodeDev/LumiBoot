import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useCompanionStore } from '../../features/companion/store';
import type { DownloadsManifest } from '../../config/downloads';
import { NetworkCompanionCard } from './NetworkCompanionCard';
import { NetworkCompanionDownload } from './NetworkCompanionDownload';
import { NetworkCompanionStatus } from './NetworkCompanionStatus';

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
  useCompanionStore.setState({
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

describe('NetworkCompanionStatus', () => {
  it('affiche l’état arrêté avec une action Réessayer', async () => {
    vi.stubGlobal('fetch', (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch);
    useCompanionStore.setState({ state: 'not-running', token: null });
    render(<NetworkCompanionStatus />);
    expect(await screen.findByText('Compagnon arrêté')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeTruthy();
  });

  it('pairing-required sans userCode : « Lancer l’appairage » seul, pas « Connecter »', async () => {
    stubHealth({ status: 'ok', version: '0.1.0', wispVersion: 1 });
    useCompanionStore.setState({ state: 'pairing-required', token: null, userCode: null });
    render(<NetworkCompanionStatus />);
    expect(await screen.findByText('En attente d’appairage')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connecter' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Lancer l’appairage' })).toBeTruthy();
  });

  it('pairing-required avec userCode : « Connecter » seul, pas « Lancer l’appairage »', async () => {
    stubHealth({ status: 'ok', version: '0.1.0', wispVersion: 1 });
    useCompanionStore.setState({ state: 'pairing-required', token: null, userCode: 'ABCD-1234' });
    render(<NetworkCompanionStatus />);
    expect(await screen.findByText('En attente d’appairage')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connecter' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Lancer l’appairage' })).toBeNull();
  });

  it('n’affiche « Connecté » que sur état connected + token', async () => {
    stubHealth({ status: 'ok', version: '0.1.0', wispVersion: 1 });
    useCompanionStore.setState({ state: 'connected', token: 'tok' });
    render(<NetworkCompanionStatus />);
    expect(await screen.findByText('Connecté')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Révoquer' })).toBeTruthy();
  });
});

describe('NetworkCompanionDownload', () => {
  it('bouton auto selon la plateforme détectée', () => {
    render(
      <NetworkCompanionDownload
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
      <NetworkCompanionDownload
        platform={{ os: 'windows', arch: 'x64', key: 'windows-x64' }}
        manifest={empty}
      />,
    );
    expect(screen.getByText(/Bientôt disponible/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Autres plateformes' }));
    expect(screen.getByText(/Windows x64.*Bientôt disponible/)).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('macOS non signée : avertissement explicite', () => {
    const macos = manifestWith({ macos: 'https://example.com/mac.tar.gz' });
    render(
      <NetworkCompanionDownload
        platform={{ os: 'macos', arch: 'unknown', key: 'macos' }}
        manifest={macos}
      />,
    );
    expect(screen.getByText(/non signée/)).toBeTruthy();
  });
});

describe('NetworkCompanionCard', () => {
  it('titre et description imposés, étapes visibles quand non connecté', async () => {
    stubHealth({ status: 'ok', version: '0.1.0', wispVersion: 1 });
    useCompanionStore.setState({ state: 'pairing-required', token: null });
    render(
      <NetworkCompanionCard
        platform={{ os: 'windows', arch: 'x64', key: 'windows-x64' }}
        manifest={PUBLISHED_WIN}
      />,
    );
    expect(await screen.findByText('Internet via votre connexion')).toBeTruthy();
    expect(screen.getByText(/utiliser directement votre connexion Internet/)).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText(/Téléchargez le compagnon/)).toBeTruthy();
    });
  });

  it('état connecté : masque les instructions d’installation', async () => {
    stubHealth({ status: 'ok', version: '0.1.0', wispVersion: 1 });
    useCompanionStore.setState({ state: 'connected', token: 'tok' });
    render(
      <NetworkCompanionCard
        platform={{ os: 'windows', arch: 'x64', key: 'windows-x64' }}
        manifest={PUBLISHED_WIN}
      />,
    );
    await waitFor(() => {
      expect(screen.queryByText(/Téléchargez le compagnon/)).toBeNull();
    });
    expect(screen.getByText('Connecté')).toBeTruthy();
  });
});
