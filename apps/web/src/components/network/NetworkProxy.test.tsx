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

/** Persists a valid, non-expired pairing session for the current URL. */
function persistSession(): void {
  saveProxySession({
    token: 'tok',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    proxyUrl: PROXY_URL,
  });
}

// Store actions replaced by spies: tests drive the state directly.
const refresh = vi.fn(async () => {});
const cancelPairing = vi.fn();
const startPairing = vi.fn(async () => {});
const revoke = vi.fn(async () => {});

beforeEach(() => {
  clearProxySession();
  refresh.mockClear();
  cancelPairing.mockClear();
  startPairing.mockClear();
  // Resets the implementation possibly overridden by a test.
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
  it('shows the title, the short description and the "Pair" button', () => {
    render(<NetworkProxyCard platform={WIN} manifest={PUBLISHED_WIN} />);
    expect(screen.getByRole('heading', { name: 'Internet via your connection' })).toBeTruthy();
    expect(screen.getByText(/Give your running systems access/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pair' })).toBeTruthy();
  });

  it('clicking "Pair" starts startPairing', async () => {
    const user = userEvent.setup();
    render(<NetworkProxyCard platform={WIN} manifest={PUBLISHED_WIN} />);
    await user.click(screen.getByRole('button', { name: 'Pair' }));
    expect(startPairing).toHaveBeenCalledTimes(1);
  });

  it('connecting state: "Pairing…" label and disabled button', () => {
    useProxyStore.setState({ state: 'connecting' });
    render(<NetworkProxyCard platform={WIN} manifest={PUBLISHED_WIN} />);
    const button = screen.getByRole('button', { name: 'Pairing…' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Pair' })).toBeNull();
  });

  it('connected + token state: "Connected" and "Disconnect", not "Pair"', () => {
    useProxyStore.setState({ state: 'connected', token: 'tok' });
    render(<NetworkProxyCard platform={WIN} manifest={PUBLISHED_WIN} />);
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pair' })).toBeNull();
    expect(screen.getByText('Your connection is shared with your systems.')).toBeTruthy();
  });

  it('discreet "Install" link present when a published target exists', () => {
    render(<NetworkProxyCard platform={WIN} manifest={PUBLISHED_WIN} />);
    const link = screen.getByRole('link', { name: 'Install' });
    expect(link.getAttribute('href')).toBe('https://example.com/win.exe');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('no "Install" link when no target is published', () => {
    render(<NetworkProxyCard platform={WIN} manifest={manifestWith({})} />);
    expect(screen.queryByRole('link', { name: 'Install' })).toBeNull();
  });

  it.each(['not-installed', 'not-running', 'permission-required', 'incompatible'] as const)(
    'passive "%s" state without a session: no alert/error shown',
    (state) => {
      useProxyStore.setState({ state });
      render(<NetworkProxyCard platform={WIN} manifest={PUBLISHED_WIN} />);
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByRole('status')).toBeNull();
      expect(screen.queryByText(/Pairing impossible/)).toBeNull();
    },
  );

  it('no session + error state: no error message and no alert shown', () => {
    useProxyStore.setState({
      state: 'error',
      error: 'A long technical store message that must not be displayed.',
    });
    render(<NetworkProxyCard platform={WIN} manifest={PUBLISHED_WIN} />);
    // No error and no alert when not paired.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    // Never the store message nor the former alarming copy.
    expect(screen.queryByText(/long technical store message/)).toBeNull();
    expect(screen.queryByText(/The proxy did not answer/)).toBeNull();
    expect(screen.queryByText(/Pairing impossible/)).toBeNull();
  });

  it('persisted session + error state: neutral "already paired" message, no error', () => {
    persistSession();
    useProxyStore.setState({ state: 'error', error: 'proxy unreachable' });
    render(<NetworkProxyCard platform={WIN} manifest={PUBLISHED_WIN} />);
    expect(screen.getByRole('status').textContent).toBe(
      'You are already paired. Restart the proxy, or click the button above to start a new pairing.',
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/Pairing impossible/)).toBeNull();
  });

  it('persisted session + not-running state: neutral "already paired" message', () => {
    persistSession();
    useProxyStore.setState({ state: 'not-running' });
    render(<NetworkProxyCard platform={WIN} manifest={PUBLISHED_WIN} />);
    expect(screen.getByRole('status').textContent).toMatch(/You are already paired/);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('clicking "Pair" (switching to connecting) hides the "already paired" message', async () => {
    const user = userEvent.setup();
    persistSession();
    useProxyStore.setState({ state: 'not-running' });
    // The real action switches to 'connecting': simulate that transition.
    startPairing.mockImplementation(async () => {
      useProxyStore.setState({ state: 'connecting' });
    });
    render(<NetworkProxyCard platform={WIN} manifest={PUBLISHED_WIN} />);
    expect(screen.getByRole('status').textContent).toMatch(/You are already paired/);

    await user.click(screen.getByRole('button', { name: 'Pair' }));

    expect(screen.queryByText(/You are already paired/)).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: 'Pairing…' })).toBeTruthy();
  });

  it('pairing-required state with a code: short "Waiting for authorization…" line', () => {
    useProxyStore.setState({ state: 'pairing-required', userCode: 'ABCD-1234' });
    render(<NetworkProxyCard platform={WIN} manifest={PUBLISHED_WIN} />);
    expect(screen.getByText('Waiting for authorization…')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('NetworkProxyDownload', () => {
  it('renders an "Install" link for the detected/injected platform', () => {
    render(<NetworkProxyDownload platform={WIN} manifest={PUBLISHED_WIN} />);
    const link = screen.getByRole('link', { name: 'Install' });
    expect(link.getAttribute('href')).toBe('https://example.com/win.exe');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('renders nothing when no published target matches', () => {
    const { container } = render(
      <NetworkProxyDownload platform={WIN} manifest={manifestWith({})} />,
    );
    expect(container.querySelector('a')).toBeNull();
  });

  it('"show all versions" toggle: hidden by default, expands every target, then collapses', async () => {
    const user = userEvent.setup();
    render(<NetworkProxyDownload platform={WIN} manifest={PUBLISHED_WIN} />);

    const toggle = screen.getByRole('button', { name: 'show all versions' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('list')).toBeNull();

    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toBe('hide versions');

    // All 5 platforms are listed.
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    // Published target is a clickable link.
    const winLink = screen.getByRole('link', { name: 'Windows x64' });
    expect(winLink.getAttribute('href')).toBe('https://example.com/win.exe');
    // Unpublished targets show as unavailable.
    expect(screen.getByText(/Windows ARM64 · Unavailable/)).toBeTruthy();
    expect(screen.getByText(/macOS · Unavailable/)).toBeTruthy();

    await user.click(toggle);
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByRole('button', { name: 'show all versions' })).toBeTruthy();
  });
});
