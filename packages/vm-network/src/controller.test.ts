import { describe, expect, it, vi } from 'vitest';
import { createNetworkController } from './controller';
import { NetworkError, isNetworkError } from './errors';

describe('createNetworkController', () => {
  it('offline : start passe en offline sans transport', async () => {
    const controller = createNetworkController({ profile: { mode: 'offline' } });
    await controller.start();
    const diagnostics = controller.snapshot();
    expect(diagnostics.status).toBe('offline');
    expect(diagnostics.transport).toBe('none');
    expect(diagnostics.verified).toBe(false);
    expect(controller.capabilities.fullInternet).toBe(false);
  });

  it('browser-fetch : start configure le transport sans prétendre connecté', async () => {
    const controller = createNetworkController({ profile: { mode: 'browser-fetch' } });
    await controller.start();
    const diagnostics = controller.snapshot();
    expect(diagnostics.status).toBe('configured');
    expect(diagnostics.transport).toBe('fetch');
    expect(diagnostics.verified).toBe(false);
  });

  it('user-relay : start rejette sans relais valide', async () => {
    const controller = createNetworkController({ profile: { mode: 'user-relay' } });
    await expect(controller.start()).rejects.toMatchObject({ code: 'NETWORK_INVALID_RELAY_URL' });
    expect(controller.snapshot().status).toBe('error');
    expect(controller.snapshot().lastError?.code).toBe('NETWORK_INVALID_RELAY_URL');
  });

  it('user-relay : une URL valide ne fait que configurer, pas connecter', async () => {
    const controller = createNetworkController({
      profile: { mode: 'user-relay', relayUrl: 'wss://relay.example' },
    });
    await controller.start();
    const diagnostics = controller.snapshot();
    expect(diagnostics.status).toBe('configured');
    expect(diagnostics.transport).toBe('wisp');
    expect(diagnostics.verified).toBe(false);
  });

  it('local-network : start rejette NETWORK_UNSUPPORTED_MODE', async () => {
    const controller = createNetworkController({ profile: { mode: 'local-network' } });
    await expect(controller.start()).rejects.toMatchObject({ code: 'NETWORK_UNSUPPORTED_MODE' });
  });

  it('setStatus est le seul chemin vers connected/online', () => {
    const controller = createNetworkController({ profile: { mode: 'browser-fetch' } });
    expect(controller.snapshot().status).toBe('idle');
    controller.setStatus('connected');
    expect(controller.snapshot().status).toBe('connected');
    expect(controller.snapshot().verified).toBe(false);
    controller.setStatus('online');
    expect(controller.snapshot().status).toBe('online');
    expect(controller.snapshot().verified).toBe(true);
  });

  it('start respecte un AbortSignal déjà avorté', async () => {
    const controller = createNetworkController({ profile: { mode: 'browser-fetch' } });
    const abort = new AbortController();
    abort.abort();
    await expect(controller.start(abort.signal)).rejects.toMatchObject({ code: 'NETWORK_ABORTED' });
  });

  it('stop et dispose sont idempotents', async () => {
    const controller = createNetworkController({ profile: { mode: 'offline' } });
    await controller.start();
    await controller.stop();
    await controller.stop();
    expect(controller.snapshot().status).toBe('stopped');
    await controller.dispose();
    await controller.dispose();
    expect(controller.snapshot().status).toBe('stopped');
  });

  it('subscribe renvoie un unsubscribe et dispose retire les auditeurs', async () => {
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

  it('après dispose, les mutations deviennent des no-op silencieux', async () => {
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

  it('reportTx/reportRx cumulent et bornent les valeurs', () => {
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

  it('reportError tronque le message et expose lastError', () => {
    const controller = createNetworkController({ profile: { mode: 'offline' } });
    controller.reportError('NETWORK_TRANSPORT_FAILED', 'x'.repeat(400));
    const diagnostics = controller.snapshot();
    expect(diagnostics.status).toBe('error');
    expect(diagnostics.lastError?.code).toBe('NETWORK_TRANSPORT_FAILED');
    expect(diagnostics.lastError?.message.length).toBe(300);
    expect(diagnostics.verified).toBe(false);
  });

  it('deux contrôleurs sont indépendants', () => {
    const first = createNetworkController({ profile: { mode: 'offline' } });
    const second = createNetworkController({ profile: { mode: 'offline' } });
    first.reportTx(10);
    first.reportError('NETWORK_TRANSPORT_FAILED', 'boom');

    expect(second.snapshot().txBytes).toBe(0);
    expect(second.snapshot().lastError).toBeUndefined();
    expect(second.snapshot().status).toBe('idle');
  });

  it('les échecs de start sont des NetworkError', async () => {
    const controller = createNetworkController({ profile: { mode: 'local-network' } });
    try {
      await controller.start();
      throw new Error('devrait rejeter');
    } catch (error) {
      expect(isNetworkError(error)).toBe(true);
      expect(error).toBeInstanceOf(NetworkError);
    }
  });
});
