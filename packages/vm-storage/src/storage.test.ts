import { describe, expect, it } from 'vitest';
import { MemoryStorageBackend } from './backend';
import { StorageError } from './errors';
import { VmDiskStorage, VmMetadataStorage, VmStorage } from './storage';

describe('VmStorage', () => {
  it('persists records and exports a snapshot', () => {
    const storage = new VmMetadataStorage({
      backend: new MemoryStorageBackend(),
      namespace: 'test',
    });
    storage.write('session-1', JSON.stringify({ state: 'running' }));

    expect(storage.read('session-1')).toContain('running');
    expect(storage.listRecords()).toHaveLength(1);
    const snapshot = storage.exportSnapshot();
    expect(snapshot.namespace).toBe('test');
    expect(snapshot.kind).toBe('metadata');
    expect(snapshot.records[0]?.key).toBe('session-1');
  });

  it('applies a quota and rejects writes that are too large', () => {
    const storage = new VmDiskStorage({ backend: new MemoryStorageBackend(), quotaBytes: 128 });
    expect(() => storage.write('small', '1234')).not.toThrow();
    expect(() => storage.write('large', 'x'.repeat(1024))).toThrow(StorageError);
  });

  it('counts the actual stored bytes for raw and record writes', () => {
    const storage = new VmStorage({ backend: new MemoryStorageBackend(), quotaBytes: 10 });
    storage.setItem('first', '123456');
    expect(storage.estimateUsageBytes()).toBe(6);
    storage.setItem('first', '1234');
    storage.setItem('second', '123456');
    expect(storage.estimateUsageBytes()).toBe(10);
    expect(() => storage.setItem('second', '1234567')).toThrow(StorageError);
  });

  it('imports a compatible snapshot transactionally', () => {
    const backend = new MemoryStorageBackend();
    const storage = new VmStorage({ backend, namespace: 'test', kind: 'metadata' });
    storage.importSnapshot({
      version: 1,
      namespace: 'test',
      kind: 'metadata',
      quotaBytes: null,
      records: [
        {
          key: 'session-2',
          value: '{"state":"stopped"}',
          createdAt: 1,
          updatedAt: 1,
          sizeBytes: 19,
        },
      ],
    });

    expect(storage.read('session-2')).toContain('stopped');
  });

  it('restores the content when an import is interrupted', () => {
    class FlakyBackend extends MemoryStorageBackend {
      override setItem(key: string, value: string): void {
        if (key.endsWith(':restored')) {
          throw new Error('boom');
        }
        super.setItem(key, value);
      }
    }

    const backend = new FlakyBackend();
    const storage = new VmStorage({ backend, namespace: 'test', kind: 'metadata' });
    storage.write('existing', 'value');

    expect(() =>
      storage.importSnapshot({
        version: 1,
        namespace: 'test',
        kind: 'metadata',
        quotaBytes: null,
        records: [
          {
            key: 'restored',
            value: 'ok',
            createdAt: 1,
            updatedAt: 1,
            sizeBytes: 2,
          },
        ],
      }),
    ).toThrow(StorageError);

    expect(storage.read('existing')).toBe('value');
    expect(storage.read('restored')).toBeNull();
  });

  it('surfaces the quota error of a failed import and restores the previous state', () => {
    const storage = new VmStorage({
      backend: new MemoryStorageBackend(),
      namespace: 'test',
      kind: 'disk',
      quotaBytes: 4096,
    });
    storage.write('existing', 'value');

    let thrown: unknown;
    try {
      storage.importSnapshot({
        version: 1,
        namespace: 'test',
        kind: 'disk',
        quotaBytes: 4096,
        records: [
          {
            key: 'huge',
            value: 'x'.repeat(4096),
            createdAt: 1,
            updatedAt: 1,
            sizeBytes: 4096,
          },
        ],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(StorageError);
    expect((thrown as StorageError).code).toBe('STORAGE_QUOTA_EXCEEDED');
    expect(storage.read('existing')).toBe('value');
    expect(storage.read('huge')).toBeNull();
  });

  it('rejects a snapshot for another namespace before changing current data', () => {
    const storage = new VmStorage({ backend: new MemoryStorageBackend(), namespace: 'current' });
    storage.write('existing', 'value');
    const snapshot = storage.exportSnapshot();
    expect(() => storage.importSnapshot({ ...snapshot, namespace: 'other' })).toThrow(StorageError);
    expect(storage.read('existing')).toBe('value');
  });

  it('validates malformed snapshot records without serializing untrusted values', () => {
    const storage = new VmStorage({ backend: new MemoryStorageBackend(), namespace: 'test' });
    storage.write('existing', 'value');
    const snapshot = storage.exportSnapshot();
    const invalid = { key: 'new', value: 1n, createdAt: 1, updatedAt: 1, sizeBytes: 1 };
    expect(() =>
      storage.importSnapshot({
        ...snapshot,
        records: [invalid as unknown as (typeof snapshot.records)[number]],
      }),
    ).toThrow(StorageError);
    expect(storage.read('existing')).toBe('value');

    const circular: (typeof snapshot.records)[number] & { self?: unknown } = {
      key: 'new',
      value: 'x',
      createdAt: 1,
      updatedAt: 1,
      sizeBytes: 1,
    };
    circular.self = circular;
    storage.importSnapshot({ ...snapshot, records: [circular] });
    expect(storage.read('new')).toBe('x');
  });

  it('detects a record whose stored key or size was tampered with', () => {
    const backend = new MemoryStorageBackend();
    const storage = new VmStorage({ backend, namespace: 'test' });
    storage.write('existing', 'value');
    const raw = JSON.parse(backend.getItem('test:existing') ?? '{}') as Record<string, unknown>;
    raw.key = 'other';
    backend.setItem('test:existing', JSON.stringify(raw));
    expect(() => storage.read('existing')).toThrow(StorageError);
    raw.key = 'existing';
    raw.sizeBytes = 999;
    backend.setItem('test:existing', JSON.stringify(raw));
    expect(() => storage.listRecords()).toThrow(StorageError);
  });
});
