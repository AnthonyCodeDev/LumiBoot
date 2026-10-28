# @lumiboot/vm-storage

Versioned key-value storage for VM metadata and disks: quotas, pluggable backend, snapshots.

## What it does

- `VmStorage` — namespaced key-value store with `getItem`, `setItem`, `removeItem`, `key`,
  `length` and `clear`.
- `VmMetadataStorage` / `VmDiskStorage` — subclasses fixing `kind` to `metadata` or `disk` and
  the default namespace `lumiboot:metadata` / `lumiboot:disk`.
- Records — `write`, `read`, `readRecord`, `delete`, `listRecords`; a record carries `key`,
  `value`, `createdAt`, `updatedAt` and `sizeBytes`.
- Quota — `quotaBytes` is compared with the projected usage before every write; an overflow
  raises `StorageError` with code `STORAGE_QUOTA_EXCEEDED`. `estimateUsageBytes()` returns the
  current total.
- Versions — `exportSnapshot()` returns `{ version: 1, namespace, kind, quotaBytes, records }`;
  `importSnapshot()` rejects other versions (`STORAGE_VERSION_MISMATCH`) and restores the
  previous content when a write fails. Version 1 is the only format understood today.
- Errors — `StorageError` and `isStorageError()`. Raised codes: `STORAGE_QUOTA_EXCEEDED`,
  `STORAGE_CORRUPTED`, `STORAGE_WRITE_FAILED` and `STORAGE_VERSION_MISMATCH`; the declared
  `STORAGE_NOT_FOUND` and `STORAGE_READ_FAILED` are not raised yet.
- Backends — `StorageBackend` is the interface (`getItem`, `setItem`, `removeItem`, `key`,
  `length`); `MemoryStorageBackend` is the only implementation shipped, and the default.

## Usage

```ts
import { MemoryStorageBackend, VmMetadataStorage } from '@lumiboot/vm-storage';

const storage = new VmMetadataStorage({ backend: new MemoryStorageBackend(), quotaBytes: 4096 });
storage.write('session-1', JSON.stringify({ state: 'running' }));
storage.read('session-1'); // '{"state":"running"}'
```

## Status

Covered by unit tests in `src/storage.test.ts`, not wired to the sessions yet. Nothing survives a
page reload: the default backend lives in memory, persisting sessions needs a `localStorage` or
IndexedDB backend.

Integration is covered by `pnpm test:e2e` on port 5200, not by the unit tests.
