import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// macOS Lion x64 under v64 + OVMF + a local OpenCore ESP: the standalone card is
// always tested, the real boot is opt-in through the operator's local media.

const assetsPresent = process.env.VM_E2E_ASSETS === '1';

/** Walks up the tree to the repository root, located by the `pnpm-workspace.yaml` marker. */
function findRepoRoot(start: string): string | null {
  let dir = resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const REPO_ROOT = findRepoRoot(process.cwd()) ?? process.cwd();
const REF = 'macos-lion-x64';
const SYSTEM_SLUG = 'macos-lion-x64';
const MANIFEST_URL = `/images/${REF}/manifest.json`;
const DISK_URL = `/images/${REF}/disk.img`;
const ESP_URL = `/images/${REF}/esp.img`;
/** Served disk size announced by the local manifest (8 GiB). */
const DISK_SIZE_BYTES = 8_589_934_592;
/** Served ESP size announced by the local manifest (64 MiB, OpenCore 1.0.8). */
const ESP_SIZE_BYTES = 67_108_864;

/**
 * The two local media live in the Git-ignored `images/` tree, served at
 * `/images/<ref>/` by the dev middleware (`createDiskAssetMiddleware`). A
 * published copy under `apps/web/public/images/<ref>/` is accepted as well, so a
 * packaged deployment can run the same proof.
 */
function findManifest(): string | null {
  const candidates = [
    join(REPO_ROOT, 'images', REF, 'manifest.json'),
    join(REPO_ROOT, 'apps', 'web', 'public', 'images', REF, 'manifest.json'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Both media must exist on disk: a manifest alone never boots. */
function disksPresent(): boolean {
  return (
    existsSync(join(REPO_ROOT, 'images', REF, 'disk.img')) &&
    existsSync(join(REPO_ROOT, 'images', REF, 'esp.img'))
  );
}

const manifestPath = findManifest();
/** Declared and servable right now (dev server or published copy). */
const mediaPresent = manifestPath !== null && disksPresent();
/** A real boot also needs the explicit opt-in. */
const localMediaPresent = assetsPresent && mediaPresent;

// Boot timeline measured in the engine (harness, 2026-11-11): the OpenCore picker
// appears within seconds, `DSMOS has arrived` at ~184 s and the Finder desktop at
// ~304 s. The same guest ran several times slower inside the product session, so
// the budget is generous; a guest that stops reading its disk is detected
// separately (`STALL_WINDOW_MS`) instead of waiting this out.
const RUNNING_TIMEOUT_MS = 900_000;
const SCREEN_TIMEOUT_MS = 2_700_000;
const STOP_TIMEOUT_MS = 60_000;

// A desktop, not a boot console: a black verbose screen sits near 0/255 mean
// luminance and a pure white failure sits at 255/255, so both are excluded.
const MIN_MEAN_LUMINANCE = 45;
const MAX_MEAN_LUMINANCE = 245;
/** The Dock and the wallpaper must be drawn: a white screen has almost none. */
const MIN_NON_WHITE_RATIO = 0.5;
const MIN_DISTINCT_COLORS = 64;
const REQUIRED_STABLE_POLLS = 3;
const POLL_INTERVAL_MS = 2_000;
/** Fingerprint points that may change without breaking stability (cursor, clock). */
const MAX_CHANGED_SAMPLES = 6;

interface CanvasSample {
  /** Mean of (r + g + b) / 3 over the sampled pixels, in 0..255. */
  readonly meanLuminance: number;
  /** Share of pixels that are not white (r + g + b < 720): a white screen fails. */
  readonly nonWhiteRatio: number;
  readonly distinctColors: number;
  /** Compact fingerprint of 64 points at 4 bits/channel, to judge stability. */
  readonly signature: number[];
  readonly canvasWidth: number;
  readonly canvasHeight: number;
}

/** Reads a snapshot of the real 2D VGA canvas, never a fake React screen. */
async function sampleCanvas(page: Page): Promise<CanvasSample | null> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.v86-screen-canvas');
    if (!canvas || canvas.width <= 0 || canvas.height <= 0) return null;
    const style = getComputedStyle(canvas);
    if (style.display === 'none' || style.visibility === 'hidden') return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    let data: Uint8ClampedArray;
    try {
      data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    } catch {
      return null;
    }

    const stride = 4;
    const step = 4 * stride;
    let total = 0;
    let nonWhite = 0;
    let luminanceSum = 0;
    const colors = new Set<number>();
    for (let i = 0; i + 2 < data.length; i += step) {
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      total += 1;
      luminanceSum += (r + g + b) / 3;
      if (r + g + b < 720) nonWhite += 1;
      // 3-bit/channel quantization, like the colorimetry measurement.
      colors.add(((r >> 5) << 10) | ((g >> 5) << 5) | (b >> 5));
    }
    if (total === 0) return null;

    const signature: number[] = [];
    const samples = 64;
    const pixels = canvas.width * canvas.height;
    for (let s = 0; s < samples; s += 1) {
      const pixel = Math.floor(((pixels - 1) * s) / (samples - 1));
      const i = pixel * 4;
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      signature.push(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
    }

    return {
      meanLuminance: luminanceSum / total,
      nonWhiteRatio: nonWhite / total,
      distinctColors: colors.size,
      signature,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
    };
  });
}

/** Number of fingerprint points that changed significantly between two polls. */
function changedSamples(previous: readonly number[], current: readonly number[]): number {
  const length = Math.min(previous.length, current.length);
  let changed = Math.abs(previous.length - current.length);
  for (let i = 0; i < length; i += 1) {
    const a = previous[i]!;
    const b = current[i]!;
    const dr = Math.abs(((a >> 8) & 0xf) - ((b >> 8) & 0xf));
    const dg = Math.abs(((a >> 4) & 0xf) - ((b >> 4) & 0xf));
    const db = Math.abs((a & 0xf) - (b & 0xf));
    if (dr + dg + db > 2) changed += 1;
  }
  return changed;
}

interface ScreenProof {
  readonly proven: boolean;
  readonly meanLuminance: number | null;
  readonly nonWhiteRatio: number | null;
  readonly distinctColors: number | null;
  readonly stablePolls: number;
  readonly canvasWidth: number | null;
  readonly canvasHeight: number | null;
  /** One line per logged poll: `t=… lum=… nonWhite=… colors=… diskMiB=…`. */
  readonly timeline: string[];
  readonly stalled: boolean;
}

/** Screenshots taken at these elapsed times (seconds), for a human diagnosis. */
const CAPTURE_AT_SECONDS = [15, 60, 120, 180, 240, 300, 420, 600, 900, 1200, 1500];
/** No disk byte for this long means the guest stopped executing, not that it is slow. */
const STALL_WINDOW_MS = 300_000;

interface DesktopProbeOptions {
  /** Bytes really served for the system disk so far. */
  readonly diskBytes: () => { bytes: number; requests: number };
  readonly startedAt: number;
  /** Appended to on every logged poll, so the caller still has it after a throw. */
  readonly timeline: string[];
}

/**
 * Waits for a painted AND stable desktop: a mean luminance a boot console never
 * reaches (black text mode, 4-17/255 measured) and a white screen always exceeds
 * (254-255/255 measured), most pixels not white, and three consecutive
 * near-identical measurements. The recorded desktop sits at 143-204/255 with
 * 195-201 colours and 72-98 % non-white pixels.
 */
async function waitForStableDesktop(
  page: Page,
  options: DesktopProbeOptions,
): Promise<ScreenProof> {
  const deadline = Date.now() + SCREEN_TIMEOUT_MS;
  const { timeline } = options;
  const captures = new Set(CAPTURE_AT_SECONDS);
  const captureDir = join(REPO_ROOT, 'test-results');
  mkdirSync(captureDir, { recursive: true });

  let previous: CanvasSample | null = null;
  let last: CanvasSample | null = null;
  let stablePolls = 0;
  let lastDiskBytes = options.diskBytes().bytes;
  let lastProgressAt = Date.now();
  let lastLogAt = 0;
  let stalled = false;

  while (Date.now() < deadline) {
    const elapsedMs = Date.now() - options.startedAt;
    const sample = await sampleCanvas(page).catch(() => null);
    const disk = options.diskBytes();
    if (disk.bytes !== lastDiskBytes) {
      lastDiskBytes = disk.bytes;
      lastProgressAt = Date.now();
    }

    if (sample !== null) {
      const line =
        `t=${(elapsedMs / 1000).toFixed(0)}s lum=${sample.meanLuminance.toFixed(1)} ` +
        `nonWhite=${sample.nonWhiteRatio.toFixed(3)} colors=${sample.distinctColors} ` +
        `${sample.canvasWidth}x${sample.canvasHeight} diskMiB=${(disk.bytes / 1048576).toFixed(1)}`;
      if (Date.now() - lastLogAt >= 15_000) {
        lastLogAt = Date.now();
        timeline.push(line);
        console.log(`[macos-lion] ${line}`);
      }

      // Periodic captures: the only way to name a stop point after a failure.
      const elapsedSeconds = Math.floor(elapsedMs / 1000);
      for (const at of Array.from(captures)) {
        if (elapsedSeconds < at) continue;
        captures.delete(at);
        await page
          .locator('.v86-screen')
          .screenshot({ path: join(captureDir, `macos-lion-progress-${at}s.png`) })
          .catch(() => undefined);
      }

      if (
        sample.meanLuminance > MIN_MEAN_LUMINANCE &&
        sample.meanLuminance < MAX_MEAN_LUMINANCE &&
        sample.nonWhiteRatio > MIN_NON_WHITE_RATIO &&
        sample.distinctColors > MIN_DISTINCT_COLORS
      ) {
        last = sample;
        stablePolls =
          previous !== null &&
          changedSamples(previous.signature, sample.signature) <= MAX_CHANGED_SAMPLES
            ? stablePolls + 1
            : 1;
        if (stablePolls >= REQUIRED_STABLE_POLLS) {
          return {
            proven: true,
            meanLuminance: sample.meanLuminance,
            nonWhiteRatio: sample.nonWhiteRatio,
            distinctColors: sample.distinctColors,
            stablePolls,
            canvasWidth: sample.canvasWidth,
            canvasHeight: sample.canvasHeight,
            timeline,
            stalled: false,
          };
        }
      } else {
        stablePolls = 0;
        last = sample;
      }
      previous = sample;
    } else if (Date.now() - lastLogAt >= 15_000) {
      // A hidden or zero-sized canvas is a diagnostic of its own: log it too.
      lastLogAt = Date.now();
      const line = `t=${(elapsedMs / 1000).toFixed(0)}s canvas unavailable`;
      timeline.push(line);
      console.log(`[macos-lion] ${line}`);
    }

    // A guest that stops reading its disk after five minutes is stuck, not slow:
    // waiting the full budget would only hide the stop point.
    if (elapsedMs > 200_000 && Date.now() - lastProgressAt > STALL_WINDOW_MS) {
      stalled = true;
      timeline.push(
        `stalled: no disk byte for ${((Date.now() - lastProgressAt) / 1000).toFixed(0)} s ` +
          `at t=${(elapsedMs / 1000).toFixed(0)}s (${(disk.bytes / 1048576).toFixed(1)} MiB read)`,
      );
      break;
    }

    await page.waitForTimeout(POLL_INTERVAL_MS);
  }

  return {
    proven: false,
    meanLuminance: last?.meanLuminance ?? null,
    nonWhiteRatio: last?.nonWhiteRatio ?? null,
    distinctColors: last?.distinctColors ?? null,
    stablePolls,
    canvasWidth: last?.canvasWidth ?? null,
    canvasHeight: last?.canvasHeight ?? null,
    timeline,
    stalled,
  };
}

/** Counts the bytes really served over HTTP Range (sum of `Content-Length`). */
function createByteCounter(
  page: Page,
  urlFragment: string,
): () => { bytes: number; requests: number } {
  let bytes = 0;
  let requests = 0;
  page.on('response', (response) => {
    if (!response.url().includes(urlFragment)) return;
    requests += 1;
    const length = Number(response.headers()['content-length'] ?? '0');
    if (Number.isFinite(length)) bytes += length;
  });
  return () => ({ bytes, requests });
}

/** Attaches the raw diagnostics on failure, never a simulated signal. */
async function attachDiagnostics(
  page: Page,
  consoleLogs: string[],
  timeline: readonly string[] = [],
): Promise<void> {
  const info = test.info();

  const serial =
    (await page
      .locator('textarea.v86-serial')
      .inputValue()
      .catch(() => '')) || '';
  await info.attach('macos-lion-serial', { body: serial, contentType: 'text/plain' });

  await info.attach('macos-lion-console', {
    body: consoleLogs.join('\n') || '(no console message)',
    contentType: 'text/plain',
  });

  if (timeline.length > 0) {
    await info.attach('macos-lion-timeline', {
      body: timeline.join('\n'),
      contentType: 'text/plain',
    });
  }

  const sessionState =
    (await page
      .locator('.session-toolbar')
      .getAttribute('data-state')
      .catch(() => null)) ?? 'unknown';
  await info.attach('macos-lion-session-state', {
    body: `data-state=${sessionState}`,
    contentType: 'text/plain',
  });

  const screen = page.locator('.v86-screen');
  if ((await screen.count()) > 0) {
    const shot = await screen.screenshot().catch(() => null);
    if (shot) {
      await info.attach('macos-lion-vga-canvas', { body: shot, contentType: 'image/png' });
      // Persistent copy: attachments alone may not survive the run directory.
      const path = join(REPO_ROOT, 'test-results', 'macos-lion-failure.png');
      mkdirSync(dirname(path), { recursive: true });
      await screen.screenshot({ path }).catch(() => undefined);
    }
  }
}

test.describe('macOS Lion x64: standalone catalog entry and honest availability', () => {
  test('is standalone and blocks or allows the launch according to the real media', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByLabel('Search for a system').fill('macos');
    const card = page.locator(`.os-card[data-id="${SYSTEM_SLUG}"]`);
    await expect(
      card,
      `System "${SYSTEM_SLUG}" missing from the catalog: no macOS Lion entry to test.`,
    ).toHaveCount(1);
    await card.click();
    await expect(page).toHaveURL(new RegExp(`/systems/${SYSTEM_SLUG}$`));

    // A STANDALONE system: macOS is a family, not a variant group here.
    await expect(page.getByRole('button', { name: 'Choose variant' })).toHaveCount(0);

    // The launch depends on the served media, never on a declared "Available".
    const launch = page.getByRole('button', { name: 'Start session' });
    await expect(launch).toBeVisible();
    if (mediaPresent) {
      await expect(
        launch,
        `images/${REF}/manifest.json and both media are present: "Start session" must be enabled.`,
      ).toBeEnabled();
    } else {
      await expect(
        launch,
        `images/${REF}/ is incomplete: "Start session" must stay disabled.`,
      ).toBeDisabled();
      await expect(
        page.getByRole('status').filter({ hasText: /disk|media|manifest|missing|unavailable/i }),
        'A disabled launch must explain the missing media instead of failing silently.',
      ).toBeVisible();
    }
  });
});

test.describe('macOS Lion x64: real boot (v64 + OVMF + OpenCore ESP)', () => {
  test.skip(!assetsPresent, `Local media missing: set VM_E2E_ASSETS=1 and provide images/${REF}/.`);
  test.skip(
    !localMediaPresent,
    `Local media missing: set VM_E2E_ASSETS=1 and provide images/${REF}/manifest.json, ` +
      'disk.img and esp.img.',
  );

  test('serves the manifest, the ESP and the disk over Range, then boots to the desktop', async ({
    page,
    request,
  }) => {
    test.setTimeout(4_200_000);

    const consoleLogs: string[] = [];
    const timeline: string[] = [];
    page.on('console', (message) => consoleLogs.push(`[${message.type()}] ${message.text()}`));
    page.on('pageerror', (error) => consoleLogs.push(`[pageerror] ${error.message}`));

    try {
      // 0. Server proofs first: JSON manifest with the two-media layout.
      const manifestResponse = await request.get(MANIFEST_URL);
      expect(
        manifestResponse.status(),
        `Manifest ${MANIFEST_URL} not served (HTTP 200 expected).`,
      ).toBe(200);
      expect(manifestResponse.headers()['content-type'] ?? '').toContain('application/json');
      const manifestBody = (await manifestResponse.json()) as {
        ref?: unknown;
        architecture?: unknown;
        memoryMiB?: unknown;
        boot?: { mode?: unknown } | undefined;
        engine?: { id?: unknown } | undefined;
        esp?: { url?: unknown; size?: unknown } | undefined;
      };
      expect(manifestBody.ref).toBe(REF);
      expect(manifestBody.architecture).toBe('x86_64');
      expect(manifestBody.boot?.mode).toBe('disk-boot');
      expect(manifestBody.engine?.id).toBe('v64');
      // Two media: the OpenCore ESP on hda and the installed Lion disk on hdb.
      expect(manifestBody.esp?.url).toBe(ESP_URL);
      expect(manifestBody.esp?.size).toBe(ESP_SIZE_BYTES);

      const espResponse = await request.get(ESP_URL, { headers: { Range: 'bytes=0-511' } });
      expect(
        espResponse.status(),
        `${ESP_URL} must answer 206 (HTTP Range): the ESP is read lazily by v64.`,
      ).toBe(206);
      expect(espResponse.headers()['content-range']).toBe(`bytes 0-511/${ESP_SIZE_BYTES}`);
      expect((await espResponse.body()).byteLength).toBe(512);

      const rangeResponse = await request.get(DISK_URL, { headers: { Range: 'bytes=0-511' } });
      expect(
        rangeResponse.status(),
        `${DISK_URL} must answer 206 (HTTP Range), never a full 200.`,
      ).toBe(206);
      expect(rangeResponse.headers()['accept-ranges']).toBe('bytes');
      expect(
        rangeResponse.headers()['content-range'],
        'The served disk must announce the expected 8 GiB size.',
      ).toBe(`bytes 0-511/${DISK_SIZE_BYTES}`);
      expect((await rangeResponse.body()).byteLength).toBe(512);

      // 1. UI path: "macos" search -> Lion card -> page.
      await page.goto('/');
      await page.getByLabel('Search for a system').fill('macos');
      const card = page.locator(`.os-card[data-id="${SYSTEM_SLUG}"]`);
      if ((await card.count()) === 0) {
        test.skip(
          true,
          `Card "${SYSTEM_SLUG}" missing: cannot start the session (honest skip, never a success).`,
        );
      }
      await card.click();
      await expect(page).toHaveURL(new RegExp(`/systems/${SYSTEM_SLUG}$`));

      // 2. Launch: two local media, no import.
      const launchButton = page.getByRole('button', { name: 'Start session' });
      await expect(launchButton).toBeEnabled();
      const diskBytes = createByteCounter(page, `/images/${REF}/disk`);
      const espBytes = createByteCounter(page, `/images/${REF}/esp`);
      const bootStartedAt = Date.now();
      await launchButton.click();
      await expect(page).toHaveURL(/\/session\//);
      await expect(page.locator('.session-console')).toBeVisible();

      // No keystroke is needed: the ESP hides auxiliary entries, so OpenCore's
      // picker lists "Lion" alone and boots it on its own timeout. OpenCore's key
      // support is unavailable under this firmware
      // (`AmiEfiKeycodeProtocol is unavailable on gST->ConsoleHandle`), so a
      // session must never depend on input at the picker.
      const screen = page.locator('.v86-screen');

      // 3. `running` follows a real disk read, never a timer.
      const state = page.locator('.session-toolbar');
      await expect(state).toHaveAttribute('data-state', 'running', {
        timeout: RUNNING_TIMEOUT_MS,
      });

      // 4. Painted AND stable desktop on the VGA canvas.
      const proof = await waitForStableDesktop(page, {
        diskBytes,
        startedAt: bootStartedAt,
        timeline,
      });
      const bootMs = Date.now() - bootStartedAt;

      // 5. Machine proof: both media were really read over HTTP Range.
      const disk = diskBytes();
      const esp = espBytes();
      expect(disk.requests, `No HTTP Range request for ${DISK_URL}.`).toBeGreaterThan(0);
      expect(disk.bytes, `No disk byte served for ${DISK_URL}.`).toBeGreaterThan(0);
      expect(
        esp.requests,
        `No HTTP Range request for ${ESP_URL}: OpenCore never loaded.`,
      ).toBeGreaterThan(0);
      expect(esp.bytes, `No ESP byte served for ${ESP_URL}.`).toBeGreaterThan(0);

      // Proof captures: VGA screen and logs, for success as well as diagnosis.
      await test.info().attach('macos-lion-x64-vga-canvas', {
        body: await page.locator('.v86-screen').screenshot(),
        contentType: 'image/png',
      });
      await test.info().attach('macos-lion-x64-serial', {
        body:
          (await page
            .locator('textarea.v86-serial')
            .inputValue()
            .catch(() => '')) || '(no serial output)',
        contentType: 'text/plain',
      });
      await test.info().attach('macos-lion-x64-console', {
        body: consoleLogs.join('\n') || '(no console message)',
        contentType: 'text/plain',
      });

      console.log(
        `\n=== macOS Lion x64 (v64 + OVMF + OpenCore ESP, disk-boot) ===\n` +
          `  expected disk              : ${DISK_URL}\n` +
          `  boot ESP                   : ${ESP_URL}\n` +
          `  boot time (click -> screen): ${(bootMs / 1000).toFixed(1)} s\n` +
          `  painted, stable desktop    : ${proof.canvasWidth}x${proof.canvasHeight}px, ` +
          `meanLuminance=${proof.meanLuminance?.toFixed(1)}/255 ` +
          `nonWhiteRatio=${proof.nonWhiteRatio?.toFixed(3)} ` +
          `distinctColors=${proof.distinctColors} stablePolls=${proof.stablePolls} ` +
          `(thresholds ${MIN_MEAN_LUMINANCE} < luminance < ${MAX_MEAN_LUMINANCE}, ` +
          `nonWhite > ${MIN_NON_WHITE_RATIO}, ${REQUIRED_STABLE_POLLS} stable polls)\n` +
          `  served disk (Range)        : ${disk.bytes} bytes ` +
          `(${(disk.bytes / 1048576).toFixed(2)} MiB) over ${disk.requests} requests\n` +
          `  served ESP (Range)         : ${esp.bytes} bytes ` +
          `(${(esp.bytes / 1048576).toFixed(2)} MiB) over ${esp.requests} requests\n` +
          `  guest RAM (manifest)       : ${String(manifestBody.memoryMiB ?? 'unknown')} MiB\n` +
          `  NOTE: a painted, stable screen is a visual proof of the desktop; ` +
          `it is not an interactive application test.\n` +
          `=== end measurements ===\n`,
      );

      // Checked last, so a failure still attaches the diagnostics from `catch`.
      expect(
        proof.proven,
        `No painted and stable macOS desktop: the canvas .v86-screen-canvas did not ` +
          `hold ${REQUIRED_STABLE_POLLS} stable polls (${MIN_MEAN_LUMINANCE} < ` +
          `meanLuminance < ${MAX_MEAN_LUMINANCE}, nonWhiteRatio > ${MIN_NON_WHITE_RATIO}, ` +
          `distinctColors > ${MIN_DISTINCT_COLORS}) within ${bootMs} ms` +
          `${proof.stalled ? ' (guest stalled: no disk read for 5 min)' : ''}. ` +
          `A black boot console or a white screen does NOT count as a desktop. ` +
          `Last sample: lum=${proof.meanLuminance ?? 'n/a'} ` +
          `nonWhite=${proof.nonWhiteRatio ?? 'n/a'} colors=${proof.distinctColors ?? 'n/a'}.`,
      ).toBe(true);

      // Persistent captures for a human visual check, in addition to the attachments.
      // Paths are anchored on the repository root, never on the current directory.
      const vgaCapturePath = join(REPO_ROOT, 'test-results', 'macos-lion-vga.png');
      mkdirSync(dirname(vgaCapturePath), { recursive: true });
      await page.locator('.v86-screen').screenshot({ path: vgaCapturePath });
      // Second capture 20 s later: the desktop must still be there.
      await page.waitForTimeout(20_000);
      await page.locator('.v86-screen').screenshot({
        path: join(REPO_ROOT, 'test-results', 'macos-lion-vga-20s.png'),
      });

      // 6. Real input, then a clean stop.
      await screen.click();
      await page.evaluate(() => document.exitPointerLock()).catch(() => undefined);
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: 'Stop' }).click();
      await expect(state).toHaveAttribute('data-state', 'stopped', { timeout: STOP_TIMEOUT_MS });
    } catch (error) {
      await attachDiagnostics(page, consoleLogs, timeline);
      throw error;
    }
  });
});
