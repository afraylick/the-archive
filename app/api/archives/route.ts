import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { getSessionUser, getPublicUsers } from '@/lib/auth';
import { readArchives, canAccessArchive, canManageArchive, DEFAULT_ARCHIVE_ACCOUNT_LIMIT, MAX_ARCHIVE_ACCOUNT_LIMIT } from '@/lib/archives';
import { newArchiveId } from '@/lib/archive-deletion';
import { validateMemberIds } from '@/lib/collections';
import { writeJsonAtomic } from '@/lib/json-storage';
import { getStorageRoot } from '@/lib/storage';
import { DEFAULT_ARCHIVE_PALETTE, isArchivePalette } from '@/lib/archive-palettes';
import type { PersonalArchive } from '@/lib/archives';
export async function GET(req: NextRequest) {
  const user = getSessionUser(req);
  if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  if (req.nextUrl.searchParams.get('view') === 'limits') {
    if (user.role !== 'owner') return NextResponse.json({ error: 'Site Owner access required' }, { status: 403 });
    const users = getPublicUsers();
    return NextResponse.json({ archives: readArchives().map(a => ({ id: a.id, name: a.name, adminName: users.find(user => user.id === a.ownerId)?.name || 'Archive Admin', deletingAt: a.deletingAt, accountLimit: a.accountLimit ?? DEFAULT_ARCHIVE_ACCOUNT_LIMIT, accountCount: users.filter(u => u.archiveScopeId === a.id).length })) });
  }
  return NextResponse.json({ archives: readArchives().filter(a => canAccessArchive(a, user)).map(a => ({ ...a, palette: a.palette ?? DEFAULT_ARCHIVE_PALETTE, accountLimit: a.accountLimit ?? DEFAULT_ARCHIVE_ACCOUNT_LIMIT, canManage: canManageArchive(a, user) })), pendingDeletions: readArchives().filter(a => a.deletingAt && a.ownerId === user.id).map(a => ({ id: a.id, name: a.name })) });
}
async function save(req: NextRequest, creating: boolean) {
  const user = getSessionUser(req);
  if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  try {
    const body = await req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid archive settings');
    if (creating && user.archiveScopeId) return NextResponse.json({ error: 'Archive-only accounts cannot create archives' }, { status: 403 });
    const archives = readArchives();
    if (creating && archives.some(a => a.ownerId === user.id)) return NextResponse.json({ error: 'You already have an archive' }, { status: 409 });
    const archive: PersonalArchive | undefined = creating ? { id: newArchiveId(user.id), ownerId: user.id, name: `${user.name}'s Archive`, memberIds: [], palette: DEFAULT_ARCHIVE_PALETTE, createdAt: new Date().toISOString() } : archives.find(a => a.id === body.id);
    if (archive?.deletingAt) return NextResponse.json({ error: 'Finish deleting this archive before changing its settings' }, { status: 409 });
    if (!creating && Object.keys(body).every(key => ['id', 'accountLimit'].includes(key)) && 'accountLimit' in body) {
      if (user.role !== 'owner') return NextResponse.json({ error: 'Only the site Owner can set account limits' }, { status: 403 });
      if (!archive || !Number.isInteger(body.accountLimit) || body.accountLimit < 0 || body.accountLimit > MAX_ARCHIVE_ACCOUNT_LIMIT) throw new Error('Choose an account limit from 0 to 100');
      archive.accountLimit = body.accountLimit;
      writeJsonAtomic(path.join(getStorageRoot(), 'archives.json'), archives);
      return NextResponse.json({ archive });
    }
    if ('accountLimit' in body) throw new Error('Update account limits separately');
    if (!archive || archive.ownerId !== user.id || user.archiveScopeId) return NextResponse.json({ error: 'Only the Archive Admin can change archive settings' }, { status: 403 });
    if ('palette' in body) {
      if (!isArchivePalette(body.palette)) throw new Error('Choose one of the eight archive palettes');
      archive.palette = body.palette;
    }
    if ('name' in body) {
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80) throw new Error('Enter an archive name (up to 80 characters)');
      archive.name = body.name.trim();
    }
    if ('memberIds' in body) archive.memberIds = validateMemberIds(body.memberIds, user.id, archive.id);
    if (creating) archives.push(archive);
    writeJsonAtomic(path.join(getStorageRoot(), 'archives.json'), archives);
    return NextResponse.json({ archive }, { status: creating ? 201 : 200 });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Archive update failed' }, { status: 400 }); }
}
export const POST = (req: NextRequest) => save(req, true);
export const PATCH = (req: NextRequest) => save(req, false);
