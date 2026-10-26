import { describe, expect, it, vi } from 'vitest';
import { createNetworkController } from './controller';
import { NetworkError, isNetworkError } from './errors';

describe('createNetworkController', () => {
  it('offline: start switches to offline without a transport', async () => {
    const controller = createNetworkController({ profile: { mode: 'offline' } });
    await controller.start();
    const diagnostics = controller.snapshot();
    expect(diagnostics.status).toBe('offline');
    expect(diagnostics.transport).toBe('none');
    expect(diagnostics.verified).toBe(false);
    expect(controller.capabilities.fullInternet).toBe(false);
  });

  it('browser-fetch: start configures the transport without claiming it is connected', async () => {
    const controller = createNetworkController({ profile: { mode: 'browser-fetch' } });
    await controller.start();
    const diagnostics = controller.snapshot();
    expect(diagnostics.status).toBe('configured');
    expect(diagnostics.transport).toBe('fetch');
    expect(diagnostics.verified).toBe(false);
  });

  it('user-relay: start rejects without a valid relay', async () => {
    const controller = createNetworkController({ profile: { mode: 'user-relay' } });
    await expect(controller.start()).rejects.toMatchObject({ code: 'NETWORK_INVALID_RELAY_URL' });
    expect(controller.snapshot().status).toBe('error');
    expect(controller.snapshot().lastError?.code).toBe('NETWORK_INVALID_RELAY_URL');
  });

  it('user-relay: a valid URL only configures, it does not connect', async () => {
    const controller = createNetworkController({
      profile: { mode: 'user-relay', relayUrl: 'wss://relay.example' },
    });
    await controller.start();
    const diagnostics = controller.snapshot();
    expect(diagnostics.status).toBe('configured');
    expect(diagnostics.transport).toBe('wisp');
    expect(diagnostics.verified).toBe(false);
  });

  it('local-proxy: start configures the transport with the default proxyUrl', async () => {
    const controller = createNetworkController({ profile: { mode: 'local-proxy' } });
    await controller.start();
    const diagnostics = controller.snapshot();
    expect(diagnostics.status).toBe('configured');
    expect(diagnostics.transport).toBe('wisp');
    expect(diagnostics.verified).toBe(false);
  });

  it('local-proxy: an invalid proxyUrl rejects with NETWORK_INVALID_PROXY_URL', async () => {
    const controller = createNetworkController({
      profile: { mode: 'local-proxy', proxyUrl: 'https://relay.example' },
    });
    await expect(controller.start()).rejects.toMatchObject({
      code: 'NETWORK_INVALID_PROXY_URL',
    });
    expect(controller.snapshot().status).toBe('error');
    expect(controller.snapshot().lastError?.code).toBe('NETWORK_INVALID_PROXY_URL');
  });

  it('local-network: start rejects with NETWORK_UNSUPPORTED_MODE', async () => {
    const controller = createNetworkController({ profile: { mode: 'local-network' } });
    await expect(controller.start()).rejects.toMatchObject({ code: 'NETWORK_UNSUPPORTED_MODE' });
  });

  it('setStatus is the only path to connected/online but proves nothing', () => {
    const controller = createNetworkController({ profile: { mode: 'browser-fetch' } });
    expect(controller.snapshot().status).toBe('idle');
    controller.setStatus('connected');
    expect(controller.snapshot().status).toBe('connected');
    expect(controller.snapshot().verified).toBe(false);
    controller.setStatus('online');
    expect(controller.snapshot().status).toBe('online');
    // `online` is a transport statement: without a successful tcp/https probe,
    // `verified` stays false (never inferred from the status or the mode).
    expect(controller.snapshot().verified).toBe(false);
  });

  it('recordProbe exposes the probes and only proves verified through tcp/https', () => {
    const controller = createNetworkController({ profile: { mode: 'browser-fetch' } });
    expect(controller.snapshot().probes).toBeUndefined();

    controller.recordProbe('dns', { ok: true, at: 1000 });
    controller.recordProbe('http', { ok: true, at: 1001 });
    expect(controller.snapshot().verified).toBe(false);

    controller.recordProbe('https', { ok: false, at: 1002, detail: 'CORS' });
    expect(controller.snapshot().verified).toBe(false);
    expect(controller.snapshot().probes?.https).toEqual({ ok: false, at: 1002, detail: 'CORS' });

    controller.recordProbe('tcp', { ok: true, at: 1003 });
    expect(controller.snapshot().verified).toBe(true);
    expect(controller.snapshot().probes?.tcp).toEqual({ ok: true, at: 1003 });
  });

  it('recordProbe recomputes verified downwards and notifies', () => {
    const controller = createNetworkController({ profile: { mode: 'browser-fetch' } });
    const listener = vi.fn();
    controller.subscribe(listener);

    controller.recordProbe('tcp', { ok: true, at: 1 });
    expect(controller.snapshot().verified).toBe(true);
    expect(listener).toHaveBeenCalled();

    controller.recordProbe('tcp', { ok: false, at: 2 });
    expect(controller.snapshot().verified).toBe(false);
    expect(controller.snapshot().probes?.tcp?.at).toBe(2);
  });

  it('recordProbe is a no-op after dispose', async () => {
    const controller = createNetworkController({ profile: { mode: 'browser-fetch' } });
    controller.recordProbe('tcp', { ok: true, at: 1 });
    await controller.dispose();

    const before = controller.snapshot();
    expect(() => controller.recordProbe('tcp', { ok: false, at: 2 })).not.toThrow();
    const after = controller.snapshot();
    expect(after.probes).toEqual(before.probes);
    expect(after.verified).toBe(false);
  });

  it('start honors an already aborted AbortSignal', async () => {
    const controller = createNetworkController({ profile: { mode: 'browser-fetch' } });
    const abort = new AbortController();
    abort.abort();
    await expect(controller.start(abort.signal)).rejects.toMatchObject({ code: 'NETWORK_ABORTED' });
  });

  it('stop and dispose are idempotent', async () => {
    const controller = createNetworkController({ profile: { mode: 'offline' } });
    await controller.start();
    await controller.stop();
    await controller.stop();
    expect(controller.snapshot().status).toBe('stopped');
    await controller.dispose();
    await controller.dispose();
    expect(controller.snapshot().status).toBe('stopped');
  });

  it('subscribe returns an unsubscribe and dispose removes the listeners', async () => {
    const controller = createNetworkController({ profile: { mode: 'offline' } });
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    await controller.start();
    expect(listener).toHaveBeenCalled();

    unsubscribe();
    listener.mockClear();
    await controller.stop();
    expect(listener).not.toHaveBeenCalled();

    const lateListener = vi.fn();
    controller.subscribe(lateListener);
    await controller.dispose();
    lateListener.mockClear();
    controller.setStatus('connected');
    expect(lateListener).not.toHaveBeenCalled();
  });

  it('after dispose, mutations become silent no-ops', async () => {
    const controller = createNetworkController({ profile: { mode: 'browser-fetch' } });
    await controller.start();
    await controller.dispose();

    const before = controller.snapshot();
    expect(() => controller.reportTx(1000)).not.toThrow();
    expect(() => controller.reportRx(1000)).not.toThrow();
    expect(() => controller.reportError('NETWORK_TRANSPORT_FAILED', 'boom')).not.toThrow();
    expect(() => controller.setStatus('online')).not.toThrow();
    await expect(controller.start()).resolves.toBeUndefined();

    const after = controller.snapshot();
    expect(after.txBytes).toBe(before.txBytes);
    expect(after.rxBytes).toBe(before.rxBytes);
    expect(after.status).toBe(before.status);
    expect(after.verified).toBe(false);
    expect(after.lastError).toBeUndefined();
  });

  it('reportTx/reportRx accumulate and clamp the values', () => {
    const controller = createNetworkController({ profile: { mode: 'offline' } });
    controller.reportTx(100);
    controller.reportTx(50);
    controller.reportRx(25);
    expect(controller.snapshot().txBytes).toBe(150);
    expect(controller.snapshot().rxBytes).toBe(25);

    controller.reportTx(Number.NaN);
    controller.reportTx(-10);
    controller.reportTx(Number.POSITIVE_INFINITY);
    expect(controller.snapshot().txBytes).toBe(150);

    controller.reportRx(Number.MAX_SAFE_INTEGER);
    controller.reportRx(Number.MAX_SAFE_INTEGER);
    expect(controller.snapshot().rxBytes).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('reportError truncates the message and exposes lastError', () => {
    const controller = createNetworkController({ profile: { mode: 'offline' } });
    controller.reportError('NETWORK_TRANSPORT_FAILED', 'x'.repeat(400));
    const diagnostics = controller.snapshot();
    expect(diagnostics.status).toBe('error');
    expect(diagnostics.lastError?.code).toBe('NETWORK_TRANSPORT_FAILED');
    expect(diagnostics.lastError?.message.length).toBe(300);
    expect(diagnostics.verified).toBe(false);
  });

  it('two controllers are independent', () => {
    const first = createNetworkController({ profile: { mode: 'offline' } });
    const second = createNetworkController({ profile: { mode: 'offline' } });
    first.reportTx(10);
    first.reportError('NETWORK_TRANSPORT_FAILED', 'boom');

    expect(second.snapshot().txBytes).toBe(0);
    expect(second.snapshot().lastError).toBeUndefined();
    expect(second.snapshot().status).toBe('idle');
  });

  it('start failures are NetworkErrors', async () => {
    const controller = createNetworkController({ profile: { mode: 'local-network' } });
    try {
      await controller.start();
      throw new Error('should reject');
    } catch (error) {
      expect(isNetworkError(error)).toBe(true);
      expect(error).toBeInstanceOf(NetworkError);
    }
  });
});
