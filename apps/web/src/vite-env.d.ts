/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public config file; same-origin absolute path only. */
  readonly VITE_LUMIBOOT_CONFIG_URL?: string;
  /** Public downloads manifest; same-origin absolute path only. */
  readonly VITE_DOWNLOADS_MANIFEST_URL?: string;
  /** Local network proxy (WISP); loopback `http(s)` URL only. */
  readonly VITE_PROXY_URL?: string;
  /** Community Discord invitation; `https:` URL without credentials only. */
  readonly VITE_DISCORD_INVITE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
