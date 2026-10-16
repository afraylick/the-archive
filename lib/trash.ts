import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';
import { getArchiveIndex } from './archive-index';
import { canEditRecording, recordingArchiveId } from './archives';
import type { ArchiveUser } from './auth';
import { readArchive, writeJsonAtomic } from './json-storage';
import { readCollections, writeCollections } from './collections';
import { cleanupStorageFile, getDataFilePath, getTranscodedDir, getStemPath, getUploadPath, isSafeStorageId } from './storage';

interface TrashRecording {
  id: string;
  archiveId?: string;
  uploadedBy?: string;
  name?: string;
  originalName?: string;
  projectId?: string;
  defaultVersionId?: string;
  collections?: string[];
  stems?: { id: string };
  trashedAt?: string;
  trashedBy?: string;
  trashBatchId?: string;
}
export class TrashError extends Error { constructor(message: string, public status = 400) { super(message); } }

/** Keep media in place. One metadata commit hides every original/version and clears all memberships. */
export function trashRecording(id: string, user: ArchiveUser) {
  const records = readArchive<TrashRecording>();
  const target = records.find(record => record.id === id && !record.trashedAt);
  if (!target) throw new TrashError('Recording not found', 404);
  if (!canEditRecording(target, user)) throw new TrashError('Recording not available', 403);
  const batch = randomUUID();
  const now = new Date().toISOString();
  const deletedIds = new Set(records.filter(record => !record.trashedAt && (record.id === id || record.projectId === id)).map(record => record.id));
  // Validate the playlist store before committing; membership in data.json is authoritative.
  const collections = readCollections(records).map(collection => ({ ...collection, trackOrder: collection.trackOrder.filter(track => !deletedIds.has(track)) }));
  const updated = records.map(record => deletedIds.has(record.id)
    ? { ...record, archiveId: recordingArchiveId(record), trashedAt: now, trashedBy: user.id, trashBatchId: batch, collections: [] }
    : record.defaultVersionId && deletedIds.has(record.defaultVersionId) ? { ...record, defaultVersionId: record.id } : record);
  writeJsonAtomic(getDataFilePath(), updated);
  // Failure here cannot restore access: the committed recordings have no memberships and are hidden by the index.
  try { writeCollections(collections); } catch (error) { console.error('Trashed playlist order cleanup failed', error); }
  return { ids: [...deletedIds], message: 'Moved to trash' };
}

export function listTrash(user: ArchiveUser, archiveId: string) {
  const records = getArchiveIndex().allMetadata as unknown as TrashRecording[];
  return records.filter(record => record.trashedAt && recordingArchiveId(record) === archiveId && canEditRecording(record, user))
    .filter(record => !record.projectId || !records.some(parent => parent.id === record.projectId && parent.trashedAt && parent.trashBatchId === record.trashBatchId))
    .map(record => ({ id: record.id, name: (record.projectId ? record.originalName || record.name : record.name || record.originalName) || 'Untitled recording', projectId: record.projectId,
      trashedAt: record.trashedAt, recordingCount: 1 + records.filter(child => child.projectId === record.id && child.trashedAt && child.trashBatchId === record.trashBatchId).length }))
    .sort((a, b) => b.trashedAt!.localeCompare(a.trashedAt!));
}

export function restoreRecording(id: string, user: ArchiveUser) {
  const records = readArchive<TrashRecording>();
  const target = records.find(record => record.id === id && record.trashedAt);
  if (!target) throw new TrashError('Recording not found in trash', 404);
  if (!canEditRecording(target, user)) throw new TrashError('Recording not available', 403);
  if (target.projectId && !records.some(parent => parent.id === target.projectId && !parent.trashedAt)) throw new TrashError('Restore the parent song before this version', 409);
  const ids = new Set(records.filter(record => record.trashedAt && (record.id === id || (record.projectId === id && record.trashBatchId === target.trashBatchId))).map(record => record.id));
  if (records.some(record => ids.has(record.id) && (!isSafeStorageId(record.id) || !fs.existsSync(getUploadPath(record.id)) || (record.stems && (!isSafeStorageId(record.stems.id) || !fs.existsSync(getStemPath(record.stems.id))))))) throw new TrashError('Recording media is missing. Keep it in trash until the missing files are recovered.', 409);
  const updated = records.map(record => {
    if (!ids.has(record.id)) return record;
    const restored = { ...record, collections: [] };
    delete restored.trashedAt; delete restored.trashedBy; delete restored.trashBatchId;
    return restored;
  });
  writeJsonAtomic(getDataFilePath(), updated);
  return { ids: [...ids], message: 'Restored. Add songs to collections manually.' };
}

export function purgeRecording(id: string, user: ArchiveUser) {
  const records = readArchive<TrashRecording>();
  const target = records.find(record => record.id === id && record.trashedAt);
  if (!target) throw new TrashError('Recording not found in trash', 404);
  if (!canEditRecording(target, user)) throw new TrashError('Recording not available', 403);
  const removed = records.filter(record => record.id === id || record.projectId === id);
  if (removed.some(record => !record.trashedAt)) throw new TrashError('Move all versions to trash first', 409);
  const ids = new Set(removed.map(record => record.id));
  writeJsonAtomic(getDataFilePath(), records.filter(record => !ids.has(record.id)));
  for (const record of removed) {
    if (isSafeStorageId(record.id)) { cleanupStorageFile(getUploadPath(record.id)); cleanupStorageFile(path.join(getTranscodedDir(), `${record.id}.mp3`)); }
    if (record.stems && isSafeStorageId(record.stems.id)) cleanupStorageFile(getStemPath(record.stems.id));
  }
  return { ids: [...ids], message: 'Permanently deleted' };
}
