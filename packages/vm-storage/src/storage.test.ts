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
});
