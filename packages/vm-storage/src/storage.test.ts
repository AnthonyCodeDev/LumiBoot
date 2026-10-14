import { describe, expect, it } from 'vitest';
import { MemoryStorageBackend } from './backend';
import { StorageError } from './errors';
import { VmStorage } from './storage';

describe('VmStorage', () => {
    it('persiste des enregistrements et exporte un snapshot', () => {
        const storage = new VmStorage({ backend: new MemoryStorageBackend(), namespace: 'test' });
        storage.write('session-1', JSON.stringify({ state: 'running' }));

        expect(storage.read('session-1')).toContain('running');
        expect(storage.listRecords()).toHaveLength(1);
        const snapshot = storage.exportSnapshot();
        expect(snapshot.namespace).toBe('test');
        expect(snapshot.records[0]?.key).toBe('session-1');
    });

    it('applique une quota et rejette les écritures trop volumineuses', () => {
        const storage = new VmStorage({ backend: new MemoryStorageBackend(), quotaBytes: 128 });
        expect(() => storage.write('small', '1234')).not.toThrow();
        expect(() => storage.write('large', 'x'.repeat(1024))).toThrow(StorageError);
    });

    it('importe un snapshot compatible', () => {
        const backend = new MemoryStorageBackend();
        const storage = new VmStorage({ backend, namespace: 'test' });
        storage.importSnapshot({
            version: 1,
            namespace: 'test',
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
});