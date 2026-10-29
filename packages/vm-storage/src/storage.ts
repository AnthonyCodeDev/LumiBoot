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
  kind: 'metadata' | 'disk';
  quotaBytes: number | null;
  records: StoredRecord<T>[];
}

export type VmStorageKind = 'metadata' | 'disk';

export interface VmStorageOptions {
  namespace?: string;
  quotaBytes?: number;
  backend?: StorageBackend | null;
  kind?: VmStorageKind;
}

const SNAPSHOT_VERSION = 1;

export class VmStorage {
  readonly #namespace: string;
  readonly #quotaBytes: number | null;
  readonly #backend: StorageBackend | null;
  readonly #kind: VmStorageKind;

  constructor(options: VmStorageOptions = {}) {
    this.#kind = options.kind ?? 'metadata';
    this.#namespace = options.namespace ?? `lumiboot:${this.#kind}`;
    this.#quotaBytes = options.quotaBytes ?? null;
    this.#backend = options.backend ?? new MemoryStorageBackend();
  }

  getItem(key: string): string | null {
    return this.#backend?.getItem(this.#key(key)) ?? null;
  }

  setItem(key: string, value: string): void {
    const nextSize = this.#projectedUsage(key, value);
    if (this.#quotaBytes !== null && nextSize > this.#quotaBytes) {
      throw new StorageError('STORAGE_QUOTA_EXCEEDED', 'Storage quota exceeded.', { key });
    }
    try {
      this.#backend?.setItem(this.#key(key), value);
    } catch (error) {
      throw new StorageError('STORAGE_WRITE_FAILED', `Failed to write "${key}".`, {
        key,
        cause: error,
      });
    }
  }

  removeItem(key: string): void {
    try {
      this.#backend?.removeItem(this.#key(key));
    } catch (error) {
      throw new StorageError('STORAGE_WRITE_FAILED', `Failed to delete "${key}".`, {
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
      records.push(parseRecord(raw, key));
    }
    return records.sort((left, right) => left.key.localeCompare(right.key));
  }

  read(key: string): string | null {
    return this.readRecord(key)?.value ?? null;
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
    return parseRecord(raw, key);
  }

  exportSnapshot(): StorageSnapshot<string> {
    return {
      version: SNAPSHOT_VERSION,
      namespace: this.#namespace,
      kind: this.#kind,
      quotaBytes: this.#quotaBytes,
      records: this.listRecords(),
    };
  }

  importSnapshot(snapshot: StorageSnapshot<string>): void {
    if (snapshot?.version !== SNAPSHOT_VERSION) {
      throw new StorageError('STORAGE_VERSION_MISMATCH', 'Unsupported snapshot version.');
    }
    if (
      snapshot.namespace !== this.#namespace ||
      snapshot.kind !== this.#kind ||
      !Array.isArray(snapshot.records)
    ) {
      throw new StorageError('STORAGE_CORRUPTED', 'Snapshot does not match this storage.');
    }
    const keys = new Set<string>();
    const records: StoredRecord<string>[] = [];
    for (const record of snapshot.records) {
      const parsed = validateRecord(record);
      if (keys.has(parsed.key)) {
        throw new StorageError('STORAGE_CORRUPTED', `Duplicate snapshot key "${parsed.key}".`, {
          key: parsed.key,
        });
      }
      keys.add(parsed.key);
      records.push(parsed);
    }

    const previous = this.#keys().map((key) => ({ key, raw: this.getItem(key) }));
    try {
      this.clear();
      for (const record of records) {
        this.setItem(record.key, JSON.stringify(record));
      }
    } catch (error) {
      try {
        this.clear();
        for (const { key, raw } of previous) {
          if (raw !== null) this.#backend?.setItem(this.#key(key), raw);
        }
      } catch (rollbackError) {
        throw new StorageError('STORAGE_WRITE_FAILED', 'Import and rollback failed.', {
          cause: new AggregateError([error, rollbackError]),
        });
      }
      // A `StorageError` already carries the real cause: do not mask it.
      if (error instanceof StorageError) throw error;
      throw new StorageError('STORAGE_WRITE_FAILED', 'Transactional import failed.', {
        cause: error,
      });
    }
  }

  estimateUsageBytes(): number {
    let total = 0;
    for (const key of this.#keys()) {
      const raw = this.getItem(key);
      if (raw !== null) total += byteLength(raw);
    }
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
    const existing = this.getItem(key);
    const current = this.estimateUsageBytes();
    const next = byteLength(value);
    return current - (existing === null ? 0 : byteLength(existing)) + next;
  }
}

function parseRecord(raw: string, key: string): StoredRecord<string> {
  try {
    return validateRecord(JSON.parse(raw), key);
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError('STORAGE_CORRUPTED', `Corrupted record for "${key}".`, {
      key,
      cause: error,
    });
  }
}

function validateRecord(value: unknown, expectedKey?: string): StoredRecord<string> {
  let key = expectedKey ?? '';
  try {
    if (
      expectedKey === undefined &&
      value !== null &&
      typeof value === 'object' &&
      'key' in value &&
      typeof value.key === 'string'
    ) {
      key = value.key;
    }
    if (
      value === null ||
      typeof value !== 'object' ||
      !('key' in value) ||
      value.key !== key ||
      !('value' in value) ||
      typeof value.value !== 'string' ||
      !('createdAt' in value) ||
      !Number.isSafeInteger(value.createdAt) ||
      !('updatedAt' in value) ||
      !Number.isSafeInteger(value.updatedAt) ||
      !('sizeBytes' in value) ||
      value.sizeBytes !== byteLength(value.value)
    ) {
      throw new Error('record format');
    }
    return {
      key: value.key,
      value: value.value,
      createdAt: value.createdAt as number,
      updatedAt: value.updatedAt as number,
      sizeBytes: value.sizeBytes as number,
    };
  } catch (error) {
    throw new StorageError('STORAGE_CORRUPTED', `Corrupted record for "${key}".`, {
      key,
      cause: error,
    });
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export class VmMetadataStorage extends VmStorage {
  constructor(options: Omit<VmStorageOptions, 'kind'> = {}) {
    super({ ...options, kind: 'metadata' });
  }
}

export class VmDiskStorage extends VmStorage {
  constructor(options: Omit<VmStorageOptions, 'kind'> = {}) {
    super({ ...options, kind: 'disk' });
  }
}
