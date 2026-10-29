/** Test-only URL fixtures: the package surface never exports them. */

import { DEFAULT_PROXY_URL } from '../proxy';

export const RELAY_ORIGIN = 'relay.example';

export const RELAY_WSS = `wss://${RELAY_ORIGIN}`;
export const RELAY_WSS_PORT = `wss://${RELAY_ORIGIN}:8443`;
export const RELAY_WSS_PATH = `${RELAY_WSS_PORT}/wisp`;
/** Insecure relay on a loopback name, accepted only with `allowInsecure`. */
export const RELAY_WS_LOCAL = 'ws://localhost:1234';
export const RELAY_PUBLIC = `https://${RELAY_ORIGIN}`;
export const OTHER_ORIGIN = 'https://other.example';
export const HOSTILE_ORIGIN = 'http://evil.example';
export const TEST_PROXY_URL = DEFAULT_PROXY_URL;
