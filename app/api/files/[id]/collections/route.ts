import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { updateRecordingCollections } from '@/lib/collections';

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getSessionUser(req);
  if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  const { id } = await params;
  try {
    const body = await req.json();
    const collections = updateRecordingCollections(id, body.collections, user);
    if (!collections) return NextResponse.json({ error: 'File not found' }, { status: 404 });
    return NextResponse.json({ collections });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Collection update failed' }, { status: 400 });
  }
}
