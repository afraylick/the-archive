import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { readCollections, createCollection, collectionForUser, canAccessCollection, collectionArchiveId } from '@/lib/collections';
import { PATCH as updateCollection, DELETE as deleteCollection } from './[id]/route';

export async function GET(req: NextRequest) {
  const user = getSessionUser(req);
  if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  try {
    const archiveId = req.nextUrl.searchParams.get('archive');
    return NextResponse.json({ collections: readCollections().filter(collection => canAccessCollection(collection, user) && (!archiveId || collectionArchiveId(collection) === archiveId)).map(collection => {
      const { comments: _comments, ...summary } = collectionForUser(collection, user);
      void _comments;
      return summary;
    }) });
  } catch {
    return NextResponse.json({ error: 'Collections could not be loaded' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const user = getSessionUser(req);
  if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  try {
    const body = await req.json();
    const collection = createCollection(body.name, user, body.visibility, body.memberIds);
    return NextResponse.json({ collection: collectionForUser(collection, user) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Collection creation failed' }, { status: 400 });
  }
}

// Keep the management screen's name-based operations compatible with playlist IDs.
async function legacyContext(req: NextRequest) {
  const body = await req.clone().json();
  const user = getSessionUser(req);
  const collection = user && readCollections().find(item => item.name === body.collection && canAccessCollection(item, user));
  return { params: Promise.resolve({ id: collection ? collection.id : '' }) };
}
export async function PATCH(req: NextRequest) {
  return updateCollection(req, await legacyContext(req));
}
export async function DELETE(req: NextRequest) {
  return deleteCollection(req, await legacyContext(req));
}
