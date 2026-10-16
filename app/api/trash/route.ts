import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { selectedArchive } from '@/lib/archives';
import { listTrash } from '@/lib/trash';
export async function GET(req: NextRequest) {
  const user = getSessionUser(req);
  if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  try {
    const archive = selectedArchive(user, req.nextUrl.searchParams.get('archive'));
    if (!archive) return NextResponse.json({ error: 'Archive unavailable' }, { status: 403 });
    return NextResponse.json({ trash: listTrash(user, archive.id), canPurge: true }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch { return NextResponse.json({ error: 'Trash could not be loaded' }, { status: 500 }); }
}
