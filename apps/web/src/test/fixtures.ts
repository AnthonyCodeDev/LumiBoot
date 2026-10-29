/** Test-only module: never import from production code. */
import { DEFAULT_PROXY_URL } from '@lumiboot/vm-network';

/** Default local network proxy origin, taken from the shared package. */
export const TEST_PROXY_URL = DEFAULT_PROXY_URL;

/** Only builds scope strings; a test never talks to the dev server. */
export const DEV_ORIGIN = 'http://127.0.0.1:5173';

/** Alternate deployment origin (pairing / origin-scoping fixtures). */
export const ALT_ORIGIN = 'https://lumiboot.example.com';

/** A second, unrelated origin (cross-origin rejection fixtures). */
export const OTHER_ORIGIN = 'https://other.example';

/** WISP relay fixtures reused by the config tests. */
export const RELAY_WSS = 'wss://relay.example';
export const RELAY_WSS_PORT = 'wss://relay.example:4000';
export const RELAY_WSS_PATH = 'wss://relay.example:4000/wisp';

/** Disk request URL carrying a bearer token, and its redacted form. */
export const DISK_ASSET_URL = 'https://127.0.0.1:37893/images/win/disk.img?token=SECRET';
export const DISK_ASSET_URL_REDACTED = 'https://127.0.0.1:37893/images/win/disk.img';
