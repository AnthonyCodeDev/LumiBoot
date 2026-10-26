import { useEffect, useState } from 'react';
import type { DownloadsManifest } from '../../config/downloads';
import { listDownloadTargets, loadDownloadsManifest } from '../../config/downloads';
import {
  detectHostPlatform,
  detectHostPlatformAsync,
  type HostPlatform,
  type PlatformKey,
} from '../../lib/platform';

export interface NetworkProxyDownloadProps {
  /** Platform injected in tests (otherwise auto-detected). */
  platform?: HostPlatform | undefined;
  /** Manifest injected in tests (otherwise loaded over the network). */
  manifest?: DownloadsManifest | undefined;
}

/** Human-readable labels for the targets, in manifest order. */
const TARGET_LABELS: Record<PlatformKey, string> = {
  'windows-x64': 'Windows x64',
  'windows-arm64': 'Windows ARM64',
  'linux-x64': 'Linux x64',
  'linux-arm64': 'Linux ARM64',
  macos: 'macOS',
};

/**
 * Discreet "Install" text link to the local network proxy build for the host
 * platform, plus a "show all versions" button that expands the list of every
 * platform in the manifest.
 *
 * Everything goes through the manifest (`/downloads/manifest.json`): no
 * hard-coded URL, and a target is only clickable when `published === true && url`.
 */
export function NetworkProxyDownload(props: NetworkProxyDownloadProps) {
  const [platform, setPlatform] = useState<HostPlatform | null>(props.platform ?? null);
  const [manifest, setManifest] = useState<DownloadsManifest | null>(props.manifest ?? null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (props.platform !== undefined || props.manifest !== undefined) return;
    let cancelled = false;
    // Immediate synchronous detection (UA), then asynchronous refinement (userAgentData).
    setPlatform(detectHostPlatform());
    void (async () => {
      try {
        const detected = await detectHostPlatformAsync();
        if (!cancelled) setPlatform(detected);
      } catch {
        // The synchronous fallback already displayed is enough.
      }
      try {
        const loaded = await loadDownloadsManifest();
        if (!cancelled) setManifest(loaded);
      } catch {
        // Manifest unavailable: no link is shown.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.platform, props.manifest]);

  if (!manifest) return null;
  const targets = listDownloadTargets(manifest);
  const primary = platform?.key ? targets.find((target) => target.key === platform.key) : undefined;

  return (
    <>
      <div className="proxy-install-row">
        {primary?.url ? (
          <a href={primary.url} target="_blank" rel="noopener noreferrer">
            Install
          </a>
        ) : null}
        <button
          type="button"
          className="proxy-versions-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'hide versions' : 'show all versions'}
        </button>
      </div>
      {expanded ? (
        <ul className="proxy-targets">
          {targets.map((target) => (
            <li key={target.key}>
              {target.url ? (
                <a href={target.url} target="_blank" rel="noopener noreferrer">
                  {TARGET_LABELS[target.key]}
                </a>
              ) : (
                <span aria-disabled="true">{TARGET_LABELS[target.key]} · Unavailable</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
