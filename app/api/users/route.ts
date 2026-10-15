import { writeJsonAtomic } from '@/lib/json-storage';
import { NextRequest, NextResponse } from 'next/server';
import {
  createUser,
  deleteUser,
  getPublicUsers,
  getSessionUser,
  getUserById,
  renameUser,
  setUserPasscode,
  setUserRole,
  type UserId,
} from '@/lib/auth';
import fs from 'fs';
import { getDataFilePath } from '@/lib/storage';
import { canEditAccount, canChangeAccountRole, canDeleteAccount } from '@/lib/roles';

interface AudioComment {
  userId?: string;
}

interface AudioFileRecord {
  id: string;
  name: string;
  ratings?: Partial<Record<UserId, number>>;
  ratingUpdatedAt?: Partial<Record<UserId, string>>;
  likedBy?: string[];
  comments?: AudioComment[];
  collections?: string[];
}

const readFiles = () => {
  const dataFile = getDataFilePath();
  return fs.existsSync(dataFile)
    ? JSON.parse(fs.readFileSync(dataFile, 'utf8')) as AudioFileRecord[]
    : [];
};

const writeFiles = (files: AudioFileRecord[]) => {
  const dataFile = getDataFilePath();
  writeJsonAtomic(dataFile, files);
};

export async function GET(req: NextRequest) {
  const user = getSessionUser(req);
  if (!user?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  const files = readFiles();
  const users = getPublicUsers().map(account => {
    const ratedSongs = files
      .filter(file => (file.ratings?.[account.id] || 0) > 0)
      .map(file => ({ id: file.id, name: file.name, rating: file.ratings?.[account.id] || 0 }));
    const likedSongs = files
      .filter(file => file.likedBy?.includes(account.id))
      .map(file => ({ id: file.id, name: file.name }));
    const commentedSongs = files.filter(file => file.comments?.some(comment => comment.userId === account.id));
    const collectionSongs = files.filter(file => (file.collections || []).length > 0);

    return {
      ...account,
      permissions: {
        canEdit: canEditAccount(user, account),
        canChangeRole: canChangeAccountRole(user, account),
        canDelete: canDeleteAccount(user, account),
      },
      stats: {
        ratingCount: ratedSongs.length,
        averageRating: ratedSongs.length
          ? Math.round((ratedSongs.reduce((sum, song) => sum + song.rating, 0) / ratedSongs.length) * 10) / 10
          : 0,
        likeCount: likedSongs.length,
        commentCount: files.reduce((count, file) => count + (file.comments?.filter(comment => comment.userId === account.id).length || 0), 0),
        collectionCount: collectionSongs.length,
      },
      ratedSongs,
      likedSongs,
      commentedSongs: commentedSongs.map(file => ({ id: file.id, name: file.name })),
    };
  });

  return NextResponse.json({ users });
}

export async function PATCH(req: NextRequest) {
  const user = getSessionUser(req);
  if (!user?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    const body = await req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['userId', 'passcode', 'name', 'role'].includes(key))) {
      return NextResponse.json({ error: 'Invalid account update' }, { status: 400 });
    }
    const { userId, passcode, name, role } = body;
    const target = typeof userId === 'string' ? getUserById(userId) : undefined;
    if (!target) {
      return NextResponse.json({ error: 'User is required' }, { status: 400 });
    }
    const actor = getSessionUser(req);
    if (!actor?.isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    if (Object.keys(body).filter(key => key !== 'userId').length !== 1) {
      return NextResponse.json({ error: 'Update name, password, and role separately' }, { status: 400 });
    }
    if ('role' in body) {
      if (!canChangeAccountRole(actor, target)) return NextResponse.json({ error: 'Only Owners can change member roles; Owner roles are protected' }, { status: 403 });
      if (role !== 'admin' && role !== 'member') return NextResponse.json({ error: 'Role must be Admin or Member' }, { status: 400 });
      return NextResponse.json({ message: 'Role updated', user: setUserRole(actor.id, userId, role) });
    }
    if (!canEditAccount(actor, target)) {
      return NextResponse.json({ error: 'Only Owners can manage other Admin or Owner accounts' }, { status: 403 });
    }
    if ((name !== undefined && typeof name !== 'string') || (passcode !== undefined && typeof passcode !== 'string')) {
      return NextResponse.json({ error: 'Name and password must be text' }, { status: 400 });
    }
    if (name?.trim()) {
      const renamedUser = renameUser(userId, name);
      return NextResponse.json({ message: 'User name updated', user: renamedUser });
    }
    if (passcode?.trim()) {
      await setUserPasscode(userId, passcode.trim(), actor.id);
      return NextResponse.json({ message: 'Password updated' });
    }

    return NextResponse.json({ error: 'A new user name or password is required' }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'User update failed' },
      { status: 400 }
    );
  }
}

export async function POST(req: NextRequest) {
  const user = getSessionUser(req);
  if (!user?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    const body = await req.json();
    if (!body || typeof body.name !== 'string' || typeof body.passcode !== 'string' || Object.keys(body).some(key => !['name', 'passcode'].includes(key))) return NextResponse.json({ error: 'New accounts must be created as Members' }, { status: 400 });
    const { name, passcode } = body;
    const createdUser = await createUser(name || '', passcode || '', user.id);
    const actor = getSessionUser(req);
    return NextResponse.json({ user: { ...createdUser, permissions: {
      canEdit: Boolean(actor && canEditAccount(actor, createdUser)),
      canChangeRole: Boolean(actor && canChangeAccountRole(actor, createdUser)),
      canDelete: Boolean(actor && canDeleteAccount(actor, createdUser)),
    } } }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'User creation failed' },
      { status: 400 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  const user = getSessionUser(req);
  if (!user?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    const { userId } = await req.json() as { userId?: UserId };
    const target = userId && getUserById(userId);
    if (!target) {
      return NextResponse.json({ error: 'User is required' }, { status: 400 });
    }
    const actor = getSessionUser(req);
    if (!actor || !canDeleteAccount(actor, target)) return NextResponse.json({ error: 'You cannot delete this account' }, { status: 403 });

    deleteUser(userId);
    const files = readFiles().map(file => ({
      ...file,
      ratings: Object.fromEntries(
        Object.entries(file.ratings || {}).filter(([ratingUserId]) => ratingUserId !== userId)
      ),
      ratingUpdatedAt: Object.fromEntries(
        Object.entries(file.ratingUpdatedAt || {}).filter(([ratingUserId]) => ratingUserId !== userId)
      ),
      likedBy: (file.likedBy || []).filter(likedUserId => likedUserId !== userId),
      comments: (file.comments || []).filter(comment => comment.userId !== userId),
    }));
    writeFiles(files);

    return NextResponse.json({ message: 'User deleted' });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'User deletion failed' },
      { status: 400 }
    );
  }
}
