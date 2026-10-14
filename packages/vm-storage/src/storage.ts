import { StorageError } from './errors';
import { MemoryStorageBackend, type StorageBackend } from './backend';

export interface StoredRecord<T = string> {
    key: string;
    value: T;
    createdAt: number;
    updatedAt: number;
    sizeBytes: number;
}

export interface StorageSnapshot<T = string> {
    version: 1;
    namespace: string;
    quotaBytes: number | null;
    records: StoredRecord<T>[];
}

export interface VmStorageOptions {
    namespace?: string;
    quotaBytes?: number;
    backend?: StorageBackend | null;
}

const SNAPSHOT_VERSION = 1;

export class VmStorage {
    readonly #namespace: string;
    readonly #quotaBytes: number | null;
    readonly #backend: StorageBackend | null;

    constructor(options: VmStorageOptions = {}) {
        this.#namespace = options.namespace ?? 'lumiboot';
        this.#quotaBytes = options.quotaBytes ?? null;
        this.#backend = options.backend ?? new MemoryStorageBackend();
    }

    getItem(key: string): string | null {
        return this.#backend?.getItem(this.#key(key)) ?? null;
    }

    setItem(key: string, value: string): void {
        const nextSize = this.#projectedUsage(key, value);
        if (this.#quotaBytes !== null && nextSize > this.#quotaBytes) {
            throw new StorageError('STORAGE_QUOTA_EXCEEDED', 'Quota de stockage dépassée.', { key });
        }
        try {
            this.#backend?.setItem(this.#key(key), value);
        } catch (error) {
            throw new StorageError('STORAGE_WRITE_FAILED', `Échec de l'écriture de « ${key} ».`, {
                key,
                cause: error,
            });
        }
    }

    removeItem(key: string): void {
        try {
            this.#backend?.removeItem(this.#key(key));
        } catch (error) {
            throw new StorageError('STORAGE_WRITE_FAILED', `Échec de la suppression de « ${key} ».`, {
                key,
                cause: error,
            });
        }
    }

    key(index: number): string | null {
        const keys = this.#keys();
        return keys[index] ?? null;
    }

    get length(): number {
        return this.#keys().length;
    }

    clear(): void {
        for (const key of this.#keys()) this.removeItem(key);
    }

    listRecords(): StoredRecord[] {
        const records: StoredRecord[] = [];
        for (const key of this.#keys()) {
            const raw = this.getItem(key);
            if (raw === null) continue;
            try {
                const parsed = JSON.parse(raw) as StoredRecord;
                if (typeof parsed.key !== 'string' || typeof parsed.value !== 'string') {
                    throw new Error('record format');
                }
                records.push(parsed);
            } catch (error) {
                throw new StorageError('STORAGE_CORRUPTED', `Enregistrement corrompu pour « ${key} ».`, {
                    key,
                    cause: error,
                });
            }
        }
        return records.sort((left, right) => left.key.localeCompare(right.key));
    }

    read(key: string): string | null {
        const raw = this.getItem(key);
        if (raw === null) return null;
        try {
            const record = JSON.parse(raw) as StoredRecord;
            return typeof record.value === 'string' ? record.value : null;
        } catch (error) {
            throw new StorageError('STORAGE_CORRUPTED', `Valeur corrompue pour « ${key} ».`, {
                key,
                cause: error,
            });
        }
    }

    write(key: string, value: string): StoredRecord<string> {
        const now = Date.now();
        const existing = this.readRecord(key);
        const record: StoredRecord<string> = {
            key,
            value,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            sizeBytes: byteLength(value),
        };
        this.setItem(key, JSON.stringify(record));
        return record;
    }

    delete(key: string): boolean {
        const present = this.getItem(key) !== null;
        this.removeItem(key);
        return present;
    }

    readRecord(key: string): StoredRecord<string> | null {
        const raw = this.getItem(key);
        if (raw === null) return null;
        try {
            const parsed = JSON.parse(raw) as StoredRecord<string>;
            if (
                typeof parsed.key !== 'string' ||
                typeof parsed.value !== 'string' ||
                typeof parsed.createdAt !== 'number' ||
                typeof parsed.updatedAt !== 'number' ||
                typeof parsed.sizeBytes !== 'number'
            ) {
                throw new Error('record format');
            }
            return parsed;
        } catch (error) {
            throw new StorageError('STORAGE_CORRUPTED', `Enregistrement corrompu pour « ${key} ».`, {
                key,
                cause: error,
            });
        }
    }

    exportSnapshot(): StorageSnapshot<string> {
        return {
            version: SNAPSHOT_VERSION,
            namespace: this.#namespace,
            quotaBytes: this.#quotaBytes,
            records: this.listRecords(),
        };
    }

    importSnapshot(snapshot: StorageSnapshot<string>): void {
        if (snapshot.version !== SNAPSHOT_VERSION) {
            throw new StorageError('STORAGE_VERSION_MISMATCH', 'Version de snapshot non prise en charge.');
        }
        this.clear();
        for (const record of snapshot.records) {
            this.write(record.key, record.value);
        }
    }

    estimateUsageBytes(): number {
        let total = 0;
        for (const record of this.listRecords()) total += record.sizeBytes;
        return total;
    }

    #key(key: string): string {
        return `${this.#namespace}:${key}`;
    }

    #keys(): string[] {
        if (!this.#backend) return [];
        const keys: string[] = [];
        for (let index = 0; index < this.#backend.length; index += 1) {
            const key = this.#backend.key(index);
            if (key !== null && key.startsWith(`${this.#namespace}:`)) {
                keys.push(key.slice(this.#namespace.length + 1));
            }
        }
        return keys;
    }

    #projectedUsage(key: string, value: string): number {
        const existing = this.readRecord(key);
        const current = this.estimateUsageBytes();
        const next = byteLength(value);
        return current - (existing?.sizeBytes ?? 0) + next;
    }
}

function byteLength(value: string): number {
    return new TextEncoder().encode(value).byteLength;
}