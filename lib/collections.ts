import { getArchivePalette } from './archive-palettes';
import { readArchives, recordingArchiveId } from './archives';
import { getArchiveIndex } from './archive-index';
import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { readArchive, writeJsonAtomic } from './json-storage';
import { getStorageRoot, getDataFilePath } from './storage';
import { getUserById, type ArchiveUser } from './auth';

export interface CollectionComment {
  id: string;
  text: string;
  userId: string;
  userName: string;
  createdAt: string;
}

export interface Collection {
  archiveId?: string;
  id: string;
  name: string;
  ownerId: string;
  membershipKeys?: string[];
  visibility: 'public' | 'private';
  memberIds: string[];
  trackOrder: string[];
  comments: CollectionComment[];
  createdAt: string;
}

interface CollectionRecording {
  trashedAt?: string;
  id: string;
  projectId?: string;
  collections?: string[];
}

const collectionRecordings = () => getArchiveIndex().metadata as unknown as CollectionRecording[];
const storePath = () => path.join(getStorageRoot(), 'collections.json');
export const collectionKeys = (collection: Collection) => collection.membershipKeys || [collection.name];
export const cleanCollectionName = (value: unknown) => typeof value === 'string' ? value.trim().slice(0, 80) : '';
export const collectionArchiveId = (collection: Collection) => collection.archiveId || readArchives().find(a => a.ownerId === collection.ownerId)?.id || 'adam';
export const canAccessCollection = (collection: Collection, user: Pick<ArchiveUser, 'id' | 'archiveScopeId'>) => (
  !readArchives().some(archive => archive.id === collectionArchiveId(collection) && archive.deletingAt) && (!user.archiveScopeId || user.archiveScopeId === collectionArchiveId(collection)) && (collection.visibility === 'public' || collection.ownerId === user.id || collection.memberIds.includes(user.id))
);
export const canEditCollection = (collection: Collection, user: Pick<ArchiveUser, 'id' | 'archiveScopeId'>) => (
  canAccessCollection(collection, user) && (collection.ownerId === user.id || collection.memberIds.includes(user.id))
);

/** Legacy tag memberships stay intact. Stable IDs give them permanent playlist URLs. */
export function readCollections(records = collectionRecordings()): Collection[] {
  const stored: Collection[] = fs.existsSync(storePath()) ? JSON.parse(fs.readFileSync(storePath(), 'utf8')) : [];
  if (!Array.isArray(stored)) throw new Error('Collection storage is unreadable');
  const names = new Set(stored.flatMap(collectionKeys));
  const legacy = [...new Set(records.filter(record => !record.trashedAt).flatMap(record => record.collections || []))].filter(name => !names.has(name));
  return [...stored, ...legacy.map(name => ({
    id: `legacy-${createHash('sha256').update(name).digest('hex').slice(0, 24)}`,
    name, ownerId: 'adam', visibility: 'public' as const, memberIds: [], trackOrder: [], comments: [],
    createdAt: new Date(0).toISOString(),
  }))];
}

export const writeCollections = (collections: Collection[]) => writeJsonAtomic(storePath(), collections);

export function collectionTrackIds(collection: Collection, records = collectionRecordings()) {
  const deletingIds = new Set(readArchives().filter(archive => archive.deletingAt).map(archive => archive.id));
  const members = records.filter(record => !record.trashedAt && !deletingIds.has(recordingArchiveId(record)) && record.collections?.some(key => collectionKeys(collection).includes(key))).map(record => record.id);
  const ids = new Set(members);
  return [...collection.trackOrder.filter(id => ids.has(id)), ...members.filter(id => !collection.trackOrder.includes(id))];
}

export function collectionForUser(collection: Collection, user: ArchiveUser, records = collectionRecordings()) {
  return { ...collection, palette: getArchivePalette(readArchives().find(archive => archive.id === collectionArchiveId(collection))?.palette).id, songIds: collectionTrackIds(collection, records), canEdit: canEditCollection(collection, user), canManage: collection.ownerId === user.id };
}

export function createCollection(name: unknown, user: ArchiveUser, visibility: unknown = 'private', memberIds: unknown = []) {
  const cleaned = cleanCollectionName(name);
  if (!cleaned) throw new Error('A collection name is required');
  if (visibility !== 'public' && visibility !== 'private') throw new Error('Choose public or private');
  const collections = readCollections();
  if (collections.some(collection => collection.name === cleaned)) throw new Error('That collection name is unavailable');
  const id = randomUUID();
  const collection: Collection = {
    id, archiveId: user.archiveScopeId || readArchives().find(a => a.ownerId === user.id)?.id || 'adam', membershipKeys: [id], name: cleaned, ownerId: user.id, visibility,
    memberIds: validateMemberIds(memberIds, user.id, user.archiveScopeId || readArchives().find(a => a.ownerId === user.id)?.id || 'adam'), trackOrder: [], comments: [], createdAt: new Date().toISOString(),
  };
  writeCollections([...collections, collection]);
  return collection;
}

export function validateMemberIds(value: unknown, ownerId: string, archiveId?: string): string[] {
  if (!Array.isArray(value) || value.length > 200 || value.some(id => typeof id !== 'string' || !getUserById(id))) throw new Error('Choose existing archive members');
  if (archiveId && (value as string[]).some(id => { const user = getUserById(id); return user?.archiveScopeId && user.archiveScopeId !== archiveId; })) throw new Error('Archive-only accounts can only join their assigned archive');
  return [...new Set(value as string[])].filter(id => id !== ownerId);
}

/** Resolve display names to stable membership keys; validate before persisting anything. */
export function resolveCollectionMemberships(names: string[], user: ArchiveUser) {
  const collections = readCollections();
  for (const name of names) {
    const collection = collections.find(item => item.name === name);
    if (collection && (!canAccessCollection(collection, user) || !canEditCollection(collection, user))) throw new Error('Only the collection owner and invited members can change its songs');
  }
  let changed = false;
  const keys = names.map(name => {
    let collection = collections.find(item => item.name === name);
    if (!collection) {
      const id = randomUUID();
      collection = { id, archiveId: user.archiveScopeId || readArchives().find(a => a.ownerId === user.id)?.id || 'adam', membershipKeys: [id], name, ownerId: user.id, visibility: 'private', memberIds: [], trackOrder: [], comments: [], createdAt: new Date().toISOString() };
      collections.push(collection);
      changed = true;
    }
    return collectionKeys(collection)[0];
  });
  if (changed) writeCollections(collections);
  return keys;
}

/** Hidden memberships must survive edits made from another user's view. */
export function updateRecordingCollections(id: string, requested: unknown, user: ArchiveUser) {
  if (!Array.isArray(requested) || requested.length > 50 || requested.some(name => typeof name !== 'string' || !name.trim() || name.length > 80)) throw new Error('Invalid collections');
  const names = [...new Set((requested as string[]).map(name => name.trim()))];
  const records = readArchive<CollectionRecording>();
  const recording = records.find(record => record.id === id && !record.trashedAt);
  if (!recording) return undefined;
  const collections = readCollections(records);
  const previous = recording.collections || [];
  const memberships = collections.filter(collection => collectionKeys(collection).some(key => previous.includes(key)));
  const visible = memberships.filter(collection => canAccessCollection(collection, user));
  for (const collection of visible) {
    if (!names.includes(collection.name) && !canEditCollection(collection, user)) throw new Error('Only the collection owner and invited members can change its songs');
  }
  const additions = names.filter(name => !visible.some(collection => collection.name === name));
  const addedKeys = resolveCollectionMemberships(additions, user);
  const keptKeys = previous.filter(key => memberships.some(collection => collectionKeys(collection).includes(key) && (!canAccessCollection(collection, user) || names.includes(collection.name))));
  recording.collections = [...new Set([...keptKeys, ...addedKeys])];
  writeJsonAtomic(getDataFilePath(), records);
  return names;
}

export function privateRatingAccess(collectionId: string | null, user: ArchiveUser, recordId: string) {
  if (!collectionId) return false;
  const collection = readCollections().find(item => item.id === collectionId);
  return Boolean(collection && collection.visibility === 'private' && canAccessCollection(collection, user) && collectionTrackIds(collection).includes(recordId));
}
