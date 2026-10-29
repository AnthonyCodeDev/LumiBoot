import type { VMMedia } from '@lumiboot/contracts';

const ROOT_DIRECTORY = 'lumiboot';
const ENGINE_DIRECTORY = 'v64';
const DISK_DIRECTORY = 'disks';

interface PersistentDiskRecord {
  readonly sourceId: string;
  readonly size: number;
  readonly updatedAt: string;
  readonly fileName?: string;
}

function diskFileName(name: string, record: PersistentDiskRecord): string {
  return record.fileName ?? `${name}.img`;
}

function newDiskFileName(name: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${name}-${suffix}.img`;
}

function safeDiskId(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) throw new Error('The persistent disk identifier is empty.');
  return normalized;
}

async function diskDirectory(): Promise<FileSystemDirectoryHandle> {
  if (!navigator.storage?.getDirectory) {
    throw new Error('Origin Private File System (OPFS) is unavailable in this browser.');
  }
  let directory = await navigator.storage.getDirectory();
  directory = await directory.getDirectoryHandle(ROOT_DIRECTORY, { create: true });
  directory = await directory.getDirectoryHandle(ENGINE_DIRECTORY, { create: true });
  return directory.getDirectoryHandle(DISK_DIRECTORY, { create: true });
}

async function readRecord(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<PersistentDiskRecord | null> {
  try {
    const file = await (await directory.getFileHandle(`${name}.json`)).getFile();
    const value = JSON.parse(await file.text()) as Partial<PersistentDiskRecord>;
    if (
      typeof value.sourceId !== 'string' ||
      typeof value.size !== 'number' ||
      !Number.isSafeInteger(value.size) ||
      value.size <= 0 ||
      typeof value.updatedAt !== 'string' ||
      (value.fileName !== undefined &&
        (typeof value.fileName !== 'string' ||
          !value.fileName.startsWith(`${name}-`) ||
          !/^[a-z0-9_-]+-[0-9a-f]{32}\.img$/.test(value.fileName)))
    ) {
      return null;
    }
    return value as PersistentDiskRecord;
  } catch {
    return null;
  }
}

async function writeRecord(
  directory: FileSystemDirectoryHandle,
  name: string,
  record: PersistentDiskRecord,
): Promise<void> {
  const handle = await directory.getFileHandle(`${name}.json`, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(JSON.stringify(record));
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }
}

/** OPFS has no cross-file transaction: commit the record before deleting the old image. */
export async function ensurePersistentV64Disk(
  id: string,
  media: VMMedia,
  signal?: AbortSignal,
): Promise<V64PersistentDisk> {
  if (media.format !== 'raw') throw new Error('Only RAW disks can be made writable in OPFS.');
  if (!media.sourceId) throw new Error('Persistent RAW media needs a stable source identity.');
  if (!Number.isSafeInteger(media.size) || media.size <= 0 || media.size % 512 !== 0)
    throw new Error('A persistent disk must contain whole 512-byte sectors.');
  if (signal?.aborted) throw new DOMException('Disk import canceled.', 'AbortError');

  const name = safeDiskId(id);
  const directory = await diskDirectory();
  const current = await readRecord(directory, name);
  if (current !== null && current.sourceId === media.sourceId && current.size === media.size) {
    const fileName = diskFileName(name, current);
    try {
      const file = await (await directory.getFileHandle(fileName)).getFile();
      if (file.size === media.size) return persistentDisk(fileName, file.size);
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error;
      // Metadata may survive an interrupted cleanup after the disk was removed.
    }
  }

  const response = await fetch(media.url, signal === undefined ? {} : { signal });
  if (!response.ok || !response.body) {
    throw new Error(`Unable to read the imported disk (HTTP ${response.status}).`);
  }
  const fileName = newDiskFileName(name);
  let metadataWriteStarted = false;
  try {
    const fileHandle = await directory.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      await response.body.pipeTo(writable, signal === undefined ? {} : { signal });
    } catch (error) {
      await writable.abort().catch(() => undefined);
      throw error;
    }
    const file = await fileHandle.getFile();
    if (file.size !== media.size) {
      throw new Error(`The OPFS copy has ${file.size} bytes instead of ${media.size}.`);
    }
    if (signal?.aborted) throw new DOMException('Disk import canceled.', 'AbortError');

    // createWritable() commits the record on close; on failure keep the staged copy.
    metadataWriteStarted = true;
    await writeRecord(directory, name, {
      sourceId: media.sourceId,
      size: file.size,
      updatedAt: new Date().toISOString(),
      fileName,
    });
    // The old generation is now unreachable: reclaim it; open readers keep their handle.
    if (current !== null) {
      const previousFileName = diskFileName(name, current);
      if (previousFileName !== fileName) {
        await directory.removeEntry(previousFileName).catch(() => undefined);
      }
    }
    await navigator.storage.persist?.().catch(() => false);
    return persistentDisk(fileName, file.size);
  } catch (error) {
    if (!metadataWriteStarted) {
      await directory.removeEntry(fileName).catch(() => undefined);
    }
    throw error;
  }
}

export interface V64PersistentDisk {
  readonly url: string;
  readonly size: number;
}

function persistentDisk(fileName: string, size: number): V64PersistentDisk {
  return { url: `opfs:${ROOT_DIRECTORY}/${ENGINE_DIRECTORY}/${DISK_DIRECTORY}/${fileName}`, size };
}
