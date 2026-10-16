import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { readArchives, canDeleteArchive, recordingArchiveId } from './archives';
import { getPublicUsers, removeArchiveAccounts, type ArchiveUser } from './auth';
import { collectionArchiveId, collectionKeys, readCollections, writeCollections } from './collections';
import { writeInboxMessages, type InboxMessage } from './inbox';
import { readArchive, writeJsonAtomic } from './json-storage';
import { getStorageRoot, getDataFilePath, getUploadPath, getStemPath, getTranscodedDir, isSafeStorageId } from './storage';

interface Recording { id: string; archiveId?: string; projectId?: string; collections?: string[]; stems?: { id: string } }
interface DeletionPlan { recordingIds: string[]; stemIds: string[]; collectionIds: string[]; collectionKeys: string[]; accountIds: string[] }
export class ArchiveDeletionError extends Error { constructor(message: string, public status = 400) { super(message); } }
const retiredStore = () => path.join(getStorageRoot(), 'retired-archive-ids.json');
function retiredArchiveIds(): string[] {
  const ids = fs.existsSync(retiredStore()) ? JSON.parse(fs.readFileSync(retiredStore(), 'utf8')) : [];
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('Retired archive storage is unreadable');
  return ids;
}
/** The first archive keeps its legacy ID. Replacements never revive old grants or uploads. */
export function newArchiveId(userId: string) {
  return retiredArchiveIds().includes(userId) ? `${userId}-${randomUUID()}` : userId;
}

/** Synchronous, resumable deletion. The registry marker closes access before any cleanup. */
export function deletePersonalArchive(id: string, confirmation: unknown, user: ArchiveUser) {
  const archives = readArchives();
  const archive = archives.find(item => item.id === id);
  if (!archive) throw new ArchiveDeletionError('Archive not found', 404);
  if (!canDeleteArchive(archive, user)) throw new ArchiveDeletionError('Only its Archive Admin or the site Owner can delete this archive', 403);
  if (confirmation !== archive.name) throw new ArchiveDeletionError('Type the archive name exactly to confirm permanent deletion');
  if (!isSafeStorageId(id)) throw new Error('Invalid archive ID');
  const manifest = path.join(getStorageRoot(), 'archive-deletions', `${id}.json`);
  const records = readArchive<Recording>();
  const collections = readCollections(records);
  const inboxFile = path.join(getStorageRoot(), 'inbox.json');
  const inbox: InboxMessage[] = fs.existsSync(inboxFile) ? JSON.parse(fs.readFileSync(inboxFile, 'utf8')) : [];
  if (!Array.isArray(inbox)) throw new Error('Inbox storage is unreadable');
  let plan: DeletionPlan;
  if (archive.deletingAt) {
    plan = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (!plan || !['recordingIds', 'stemIds', 'collectionIds', 'collectionKeys', 'accountIds'].every(key => Array.isArray(plan[key as keyof DeletionPlan]) && plan[key as keyof DeletionPlan].every(value => typeof value === 'string'))) throw new Error('Archive deletion plan is unreadable');
  } else {
    const removed = records.filter(record => recordingArchiveId(record) === id);
    const removedCollections = collections.filter(collection => collectionArchiveId(collection) === id);
    plan = { recordingIds: removed.map(record => record.id), stemIds: removed.flatMap(record => record.stems ? [record.stems.id] : []), collectionIds: removedCollections.map(collection => collection.id), collectionKeys: removedCollections.flatMap(collectionKeys), accountIds: getPublicUsers().filter(account => account.archiveScopeId === id).map(account => account.id) };
    // Validate all source stores and the retirement ledger before closing the archive.
    retiredArchiveIds();
    writeJsonAtomic(manifest, plan);
    archive.deletingAt = new Date().toISOString();
    writeJsonAtomic(path.join(getStorageRoot(), 'archives.json'), archives);
  }
  const removedIds = new Set(plan.recordingIds);
  const removedCollections = new Set(plan.collectionIds);
  const removedKeys = new Set(plan.collectionKeys);
  const removedAccounts = new Set(plan.accountIds);
  writeJsonAtomic(getDataFilePath(), records.filter(record => !removedIds.has(record.id)).map(record => {
    if (!record.collections?.some(key => removedKeys.has(key))) return record;
    return { ...record, collections: record.collections.filter(key => !removedKeys.has(key)) };
  }));
  writeCollections(collections.filter(collection => !removedCollections.has(collection.id)).map(collection => ({ ...collection, trackOrder: collection.trackOrder.filter(track => !removedIds.has(track)), memberIds: collection.memberIds.filter(member => !removedAccounts.has(member)) })));
  writeInboxMessages(inbox.filter(message => !removedIds.has(message.songId) && !removedAccounts.has(message.recipientUserId) && !removedAccounts.has(message.senderUserId)));
  removeArchiveAccounts(id, plan.accountIds);
  // Keep the manifest and closed registry entry if any removal fails, so retry can finish.
  for (const recordingId of plan.recordingIds) {
    if (!isSafeStorageId(recordingId)) throw new Error('Invalid recording ID in archive deletion');
    fs.rmSync(getUploadPath(recordingId), { force: true });
    fs.rmSync(path.join(getTranscodedDir(), `${recordingId}.mp3`), { force: true });
  }
  for (const stemId of plan.stemIds) {
    if (!isSafeStorageId(stemId)) throw new Error('Invalid stem ID in archive deletion');
    fs.rmSync(getStemPath(stemId), { force: true });
  }
  writeJsonAtomic(retiredStore(), [...new Set([...retiredArchiveIds(), id])]);
  writeJsonAtomic(path.join(getStorageRoot(), 'archives.json'), archives.filter(item => item.id !== id).map(item => ({ ...item, memberIds: item.memberIds.filter(member => !removedAccounts.has(member)) })));
  try { fs.rmSync(manifest, { force: true }); } catch (error) { console.error('Completed archive deletion manifest cleanup failed', error); }
  return { message: 'Archive permanently deleted. Your site account is unchanged.' };
}
