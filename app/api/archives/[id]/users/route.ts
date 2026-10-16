import { NextRequest, NextResponse } from 'next/server';
import { createUser, deleteUser, getPublicUsers, getSessionUser, getUserById, renameUser, setUserPasscode } from '@/lib/auth';
import { readArchives, DEFAULT_ARCHIVE_ACCOUNT_LIMIT } from '@/lib/archives';
type Context = { params: Promise<{ id: string }> };
function owner(req: NextRequest, id: string) {
  const user = getSessionUser(req);
  return user && !user.archiveScopeId && readArchives().some(archive => archive.id === id && !archive.deletingAt && archive.ownerId === user.id) ? user : null;
}
export async function GET(req: NextRequest, context: Context) {
  const { id } = await context.params;
  if (!owner(req, id)) return NextResponse.json({ error: 'Archive Admin access required' }, { status: 403 });
  const archive = readArchives().find(a => a.id === id)!;
  return NextResponse.json({ users: getPublicUsers().filter(user => user.archiveScopeId === id).map(user => ({ ...user, hasAccess: archive.memberIds.includes(user.id) })), limit: archive.accountLimit ?? DEFAULT_ARCHIVE_ACCOUNT_LIMIT });
}
export async function POST(req: NextRequest, context: Context) {
  const { id } = await context.params;
  const actor = owner(req, id);
  if (!actor) return NextResponse.json({ error: 'Archive Admin access required' }, { status: 403 });
  try {
    const body = await req.json();
    if (!body || typeof body.name !== 'string' || typeof body.passcode !== 'string' || Object.keys(body).some(key => !['name', 'passcode'].includes(key))) throw new Error('Enter a name and password');
    const user = await createUser(body.name, body.passcode, actor.id, id);
    return NextResponse.json({ user }, { status: 201 });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Account could not be created' }, { status: 400 }); }
}
export async function PATCH(req: NextRequest, context: Context) {
  const { id } = await context.params;
  try {
    const body = await req.json();
    const actor = owner(req, id);
    const target = typeof body?.userId === 'string' && getUserById(body.userId);
    if (!actor || !target || target.archiveScopeId !== id) return NextResponse.json({ error: 'You can only manage accounts created for your archive' }, { status: 403 });
    if (typeof body.passcode === 'string' && Object.keys(body).every(key => ['userId', 'passcode'].includes(key))) await setUserPasscode(target.id, body.passcode, actor.id);
    else if (typeof body.name === 'string' && Object.keys(body).every(key => ['userId', 'name'].includes(key))) renameUser(target.id, body.name);
    else throw new Error('Update name or password separately');
    return NextResponse.json({ message: 'Account updated' });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Account update failed' }, { status: 400 }); }
}
export async function DELETE(req: NextRequest, context: Context) {
  const { id } = await context.params;
  try {
    const body = await req.json();
    const actor = owner(req, id);
    const target = typeof body?.userId === 'string' && getUserById(body.userId);
    if (!actor || !target || target.archiveScopeId !== id) return NextResponse.json({ error: 'You can only remove accounts created for your archive' }, { status: 403 });
    deleteUser(target.id);
    return NextResponse.json({ message: 'Account removed. Existing recordings and comments are retained.' });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Account removal failed' }, { status: 400 }); }
}
