import { NextResponse, type NextRequest } from 'next/server';
import { getSessionUser, type ArchiveUser } from './auth';
import { getArchiveIndex } from './archive-index';
import { canReadRecording, canEditRecording } from './archives';
import { readCollections, canAccessCollection, collectionTrackIds } from './collections';
export function canReadInCollection(id: string, collectionId: string | null, user: ArchiveUser) {
  if (!collectionId) return false;
  const collection = readCollections().find(c => c.id === collectionId && canAccessCollection(c, user));
  return Boolean(collection && collectionTrackIds(collection).includes(id));
}
/** Every byte/interaction endpoint checks authoritative membership, never a client permission flag. */
export function recordingAccess(req: NextRequest, id: string, mode: 'read' | 'edit' | 'archive' = 'read') {
  const user = getSessionUser(req);
  if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  try {
    const record = getArchiveIndex().byId.get(id);
    if (!record) return NextResponse.json({ error: 'Recording not found' }, { status: 404 });
    const allowed = mode === 'edit' ? canEditRecording(record, user) : canReadRecording(record, user) || (mode === 'read' && canReadInCollection(id, req.nextUrl.searchParams.get('collection'), user));
    return allowed ? null : NextResponse.json({ error: 'Recording not available' }, { status: 403 });
  } catch { return NextResponse.json({ error: 'Recording access could not be checked' }, { status: 500 }); }
}
