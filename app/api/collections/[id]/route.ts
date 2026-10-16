import { canReadRecording } from '@/lib/archives';
import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { readArchive, writeJsonAtomic } from '@/lib/json-storage';
import { getDataFilePath } from '@/lib/storage';
import { collectionArchiveId, readCollections, writeCollections, collectionForUser, canAccessCollection, canEditCollection, cleanCollectionName, validateMemberIds, collectionTrackIds, collectionKeys } from '@/lib/collections';

type Context = { params: Promise<{ id: string }> };
interface Recording { id: string; trashedAt?: string; projectId?: string; collections?: string[] }

export async function GET(req: NextRequest, context: Context) {
  const user = getSessionUser(req);
  if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  const { id } = await context.params;
  const collection = readCollections().find(item => item.id === id && canAccessCollection(item, user));
  if (!collection) return NextResponse.json({ error: 'Collection not found or unavailable' }, { status: 404 });
  return NextResponse.json({ collection: collectionForUser(collection, user) });
}

export async function PATCH(req: NextRequest, context: Context) {
  const user = getSessionUser(req);
  if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  const { id } = await context.params;
  try {
    const body = await req.json();
    const records = readArchive<Recording>();
    const collections = readCollections(records);
    const collection = collections.find(item => item.id === id && canAccessCollection(item, user));
    if (!collection) return NextResponse.json({ error: 'Collection not found or unavailable' }, { status: 404 });
    if (!canEditCollection(collection, user)) return NextResponse.json({ error: 'Only the owner and invited members can edit this collection' }, { status: 403 });
    const allowed = ['name', 'visibility', 'memberIds', 'addSongId', 'removeSongId', 'moveSongId', 'direction', 'collection'];
    if (!body || typeof body !== 'object' || Object.keys(body).some(key => !allowed.includes(key))) return NextResponse.json({ error: 'Invalid collection update' }, { status: 400 });
    const settings = ['name', 'visibility', 'memberIds'].some(key => key in body);
    if (settings && collection.ownerId !== user.id) return NextResponse.json({ error: 'Only the owner can change sharing and collection settings' }, { status: 403 });
    let filesUpdated = 0;
    if (settings) {
      if ('visibility' in body && body.visibility !== 'public' && body.visibility !== 'private') throw new Error('Choose public or private');
      const members = 'memberIds' in body ? validateMemberIds(body.memberIds, collection.ownerId, collectionArchiveId(collection)) : collection.memberIds;
      const name = 'name' in body ? cleanCollectionName(body.name) : collection.name;
      if (!name) throw new Error('A collection name is required');
      const existing = collections.find(item => item.id !== id && item.name === name);
      // Legacy management supported merging names. Restrict this to collections with identical access.
      if (existing && (existing.ownerId !== user.id || existing.visibility !== collection.visibility || JSON.stringify([...existing.memberIds].sort()) !== JSON.stringify([...members].sort()))) throw new Error('That collection name is unavailable');
      filesUpdated = records.filter(record => record.collections?.some(key => collectionKeys(collection).includes(key))).length;
      collection.membershipKeys = collectionKeys(collection);

      if (existing) {
        collection.trackOrder = [...new Set([...collectionTrackIds(collection, records), ...collectionTrackIds(existing, records)])];
        collection.membershipKeys = [...new Set([...collection.membershipKeys, ...collectionKeys(existing)])];
        collection.comments = [...existing.comments, ...collection.comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        collections.splice(collections.indexOf(existing), 1);
      }
      collection.name = name;
      collection.memberIds = members;
      if ('visibility' in body) collection.visibility = body.visibility;
    } else if ('addSongId' in body || 'removeSongId' in body) {
      const adding = 'addSongId' in body;
      const songId = adding ? body.addSongId : body.removeSongId;
      const record = records.find(record => record.id === songId && !record.trashedAt);
      if (!record) throw new Error('Song not found');
      if (adding && !canReadRecording(record, user)) return NextResponse.json({ error: 'Archive access is required to share this song' }, { status: 403 });
      const current = record.collections || [];
      record.collections = adding ? [...new Set([...current, collectionKeys(collection)[0]])] : current.filter(key => !collectionKeys(collection).includes(key));
      collection.trackOrder = collectionTrackIds(collection, records);
      filesUpdated = 1;
    } else if ('moveSongId' in body) {
      const order = collectionTrackIds(collection, records);
      const index = order.indexOf(body.moveSongId);
      const destination = index + (body.direction === 'up' ? -1 : body.direction === 'down' ? 1 : 0);
      if (index < 0 || !['up', 'down'].includes(body.direction)) throw new Error('Invalid playlist move');
      if (destination >= 0 && destination < order.length) [order[index], order[destination]] = [order[destination], order[index]];
      collection.trackOrder = order;
    } else throw new Error('Choose a collection update');
    // All validation finishes before either store is changed.
    if ('addSongId' in body || 'removeSongId' in body) writeJsonAtomic(getDataFilePath(), records);
    writeCollections(collections);
    const changedRecording = records.find(record => record.id === (body.addSongId || body.removeSongId));
    const recording = changedRecording ? {
      id: changedRecording.id,
      collections: collections.filter(item => canAccessCollection(item, user) && collectionKeys(item).some(key => changedRecording.collections?.includes(key))).map(item => item.name),
    } : undefined;
    return NextResponse.json({ collection: body.collection ? collection.name : collectionForUser(collection, user, records), filesUpdated, recording });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Collection update failed' }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest, context: Context) {
  const user = getSessionUser(req);
  if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  const { id } = await context.params;
  const records = readArchive<Recording>();
  const collections = readCollections(records);
  const collection = collections.find(item => item.id === id && canAccessCollection(item, user));
  if (!collection) return NextResponse.json({ error: 'Collection not found or unavailable' }, { status: 404 });
  if (collection.ownerId !== user.id) return NextResponse.json({ error: 'Only the owner can delete this collection' }, { status: 403 });
  let filesUpdated = 0;
  for (const record of records) {
    if (record.collections?.some(key => collectionKeys(collection).includes(key))) {
      record.collections = record.collections.filter(key => !collectionKeys(collection).includes(key));
      filesUpdated++;
    }
  }
  if (filesUpdated) writeJsonAtomic(getDataFilePath(), records);
  writeCollections(collections.filter(item => item.id !== id));
  return NextResponse.json({ filesUpdated });
}
