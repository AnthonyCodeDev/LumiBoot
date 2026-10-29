/** Local copy of the relay fixtures: the guardrail forbids a package subpath import. */

export const RELAY_ORIGIN = 'relay.example.com';

export const RELAY_WSS = `wss://${RELAY_ORIGIN}`;
export const RELAY_WSS_PORT = `wss://${RELAY_ORIGIN}:8443`;
export const RELAY_WSS_PATH = `${RELAY_WSS_PORT}/wisp`;

/** The discard port on loopback: valid for the validator, never reachable. */
export const DISCARD_WISP_URL = 'wss://127.0.0.1:9/';

export const CDN_DISK_URL = 'https://cdn.example.com/disk.img';
export const CDN_DISK_URL_2 = 'https://cdn.example.com/a.img';
