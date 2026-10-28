// Kept outside /v64/ so this tiny loader is tracked while runtime binaries are not.
// A script tag may load public assets as-is; importing them from Vite source is rejected.
import * as runtime from '/v64/libv86.mjs';

globalThis.__lumibootV64Resolve?.(runtime);
