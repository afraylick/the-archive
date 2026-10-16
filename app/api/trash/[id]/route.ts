import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { restoreRecording, purgeRecording, TrashError } from '@/lib/trash';
type Context = { params: Promise<{ id: string }> };
async function act(req: NextRequest, context: Context, purge: boolean) {
  const user = getSessionUser(req);
  if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  try {
    const { id } = await context.params;
    if (purge && (await req.json()).confirmation !== 'DELETE') throw new TrashError('Confirm permanent deletion');
    return NextResponse.json(purge ? purgeRecording(id, user) : restoreRecording(id, user));
  } catch (error) { return NextResponse.json({ error: error instanceof TrashError ? error.message : 'Trash update failed' }, { status: error instanceof TrashError ? error.status : 500 }); }
}
export const POST = (req: NextRequest, context: Context) => act(req, context, false);
export const DELETE = (req: NextRequest, context: Context) => act(req, context, true);
