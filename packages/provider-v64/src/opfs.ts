import type { VMMedia } from '@lumiboot/contracts';

const ROOT_DIRECTORY = 'lumiboot';
const ENGINE_DIRECTORY = 'v64';
const DISK_DIRECTORY = 'disks';

interface PersistentDiskRecord {
  readonly sourceId: string;
  readonly size: number;
  readonly updatedAt: string;
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
      typeof value.updatedAt !== 'string'
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
  await writable.write(JSON.stringify(record));
  await writable.close();
}

/**
 * Copies an imported RAW disk into OPFS once, then reuses the guest-modified
 * copy on every boot. A newly imported source gets a new `sourceId` and
 * replaces the old copy deliberately.
 */
export async function ensurePersistentV64Disk(
  id: string,
  media: VMMedia,
  signal?: AbortSignal,
): Promise<V64PersistentDisk> {
  if (media.format !== 'raw') throw new Error('Only RAW disks can be made writable in OPFS.');
  if (!media.sourceId) throw new Error('Persistent RAW media needs a stable source identity.');
  if (media.size % 512 !== 0)
    throw new Error('A persistent disk must contain whole 512-byte sectors.');
  if (signal?.aborted) throw new DOMException('Disk import canceled.', 'AbortError');

  const name = safeDiskId(id);
  const directory = await diskDirectory();
  const current = await readRecord(directory, name);
  if (current !== null && current.sourceId === media.sourceId && current.size === media.size) {
    const file = await (await directory.getFileHandle(`${name}.img`)).getFile();
    if (file.size === media.size) return persistentDisk(name, file.size);
  }

  const response = await fetch(media.url, signal === undefined ? {} : { signal });
  if (!response.ok || !response.body) {
    throw new Error(`Unable to read the imported disk (HTTP ${response.status}).`);
  }
  const fileHandle = await directory.getFileHandle(`${name}.img`, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await response.body.pipeTo(writable, signal === undefined ? {} : { signal });
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }
  const file = await fileHandle.getFile();
  if (file.size !== media.size) {
    await directory.removeEntry(`${name}.img`).catch(() => undefined);
    throw new Error(`The OPFS copy has ${file.size} bytes instead of ${media.size}.`);
  }
  await writeRecord(directory, name, {
    sourceId: media.sourceId,
    size: file.size,
    updatedAt: new Date().toISOString(),
  });
  await navigator.storage.persist?.().catch(() => false);
  return persistentDisk(name, file.size);
}

export interface V64PersistentDisk {
  readonly url: string;
  readonly size: number;
}

function persistentDisk(name: string, size: number): V64PersistentDisk {
  return { url: `opfs:${ROOT_DIRECTORY}/${ENGINE_DIRECTORY}/${DISK_DIRECTORY}/${name}.img`, size };
}
