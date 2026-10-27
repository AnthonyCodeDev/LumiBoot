import { useEffect, useState } from 'react';
import { useProxyStore } from '../../features/proxy/store';
import { loadProxySession } from '../../features/proxy/persistence';
import { resolveProxyConfig } from '../../config/runtime';
import type { DownloadsManifest } from '../../config/downloads';
import type { HostPlatform } from '../../lib/platform';
import { Button } from '../ui/Button';
import { NetworkProxyDownload } from './NetworkProxyDownload';

export interface NetworkProxyCardProps {
  platform?: HostPlatform | undefined;
  manifest?: DownloadsManifest | undefined;
}

/** Pairing card for the local network proxy. */
export function NetworkProxyCard(props: NetworkProxyCardProps) {
  const state = useProxyStore((s) => s.state);
  const token = useProxyStore((s) => s.token);
  const userCode = useProxyStore((s) => s.userCode);
  const startPairing = useProxyStore((s) => s.startPairing);
  const revoke = useProxyStore((s) => s.revoke);
  const refresh = useProxyStore((s) => s.refresh);
  const cancelPairing = useProxyStore((s) => s.cancelPairing);

  const { url: proxyUrl } = resolveProxyConfig();

  // Lazy init avoids a flash on mount.
  const [hasSession, setHasSession] = useState(() => loadProxySession(proxyUrl) !== null);
  useEffect(() => {
    setHasSession(loadProxySession(proxyUrl) !== null);
  }, [state, token, proxyUrl]);

  const connected = state === 'connected' && token !== null;
  const connecting = state === 'connecting';

  // Shown while a session persists but the proxy is not connected.
  const alreadyPairedMessage =
    !connected && !connecting && hasSession
      ? 'You are already paired. Restart the proxy, or click the button above to start a new pairing.'
      : null;

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Unmount: cancel any in-flight pairing watch.
  useEffect(() => () => cancelPairing(), [cancelPairing]);

  return (
    <section className="proxy-card" aria-label="Internet via your connection">
      <h2>Internet via your connection</h2>
      <p className="proxy-description">
        Give your running systems access to your Internet connection, straight from the browser.
      </p>
      <div className="proxy-actions">
        {connected ? (
          <>
            <span className="proxy-connected">Connected</span>
            <Button variant="ghost" type="button" onClick={() => void revoke()}>
              Disconnect
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            type="button"
            disabled={connecting}
            onClick={() => void startPairing()}
          >
            {connecting ? 'Pairing…' : 'Pair'}
          </Button>
        )}
      </div>
      {connected ? (
        <p className="proxy-note">Your connection is shared with your systems.</p>
      ) : (
        <div className="proxy-note">
          LumiBoot Network Proxy bridges your systems and your connection.{' '}
          <NetworkProxyDownload platform={props.platform} manifest={props.manifest} />
        </div>
      )}
      {state === 'pairing-required' && userCode ? (
        <p className="proxy-note" role="status">
          Waiting for authorization…
        </p>
      ) : null}
      {alreadyPairedMessage ? (
        <p className="proxy-note" role="status">
          {alreadyPairedMessage}
        </p>
      ) : null}
    </section>
  );
}
