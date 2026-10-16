import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { deletePersonalArchive, ArchiveDeletionError } from '@/lib/archive-deletion';

export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = getSessionUser(req);
  if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  const { id } = await context.params;
  let body;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid archive deletion request' }, { status: 400 }); }
  try {
    return NextResponse.json(deletePersonalArchive(id, body?.confirmation, user));
  } catch (error) {
    if (error instanceof ArchiveDeletionError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('Archive deletion failed', error);
    return NextResponse.json({ error: 'Archive deletion could not finish. Retry deletion to complete cleanup.' }, { status: 500 });
  }
}
