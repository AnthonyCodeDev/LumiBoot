export interface StorageBackend {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
    key(index: number): string | null;
    readonly length: number;
}

export class MemoryStorageBackend implements StorageBackend {
    readonly #entries = new Map<string, string>();

    get length(): number {
        return this.#entries.size;
    }

    getItem(key: string): string | null {
        return this.#entries.get(key) ?? null;
    }

    setItem(key: string, value: string): void {
        this.#entries.set(key, value);
    }

    removeItem(key: string): void {
        this.#entries.delete(key);
    }

    key(index: number): string | null {
        return [...this.#entries.keys()][index] ?? null;
    }
}