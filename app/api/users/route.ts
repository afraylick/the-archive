import { NextRequest, NextResponse } from 'next/server';
import {
  createUser,
  deleteUser,
  getPublicUsers,
  getSessionUser,
  getUserById,
  isPasscodeInUse,
  setUserPasscode,
  type UserId,
} from '@/lib/auth';
import fs from 'fs';
import { getDataFilePath } from '@/lib/storage';

interface AudioComment {
  userId?: string;
}

interface AudioFileRecord {
  id: string;
  name: string;
  ratings?: Partial<Record<UserId, number>>;
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
  fs.writeFileSync(dataFile, JSON.stringify(files, null, 2));
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

  const { userId, passcode } = await req.json() as { userId?: UserId; passcode?: string };
  if (!userId || !getUserById(userId) || !passcode?.trim()) {
    return NextResponse.json({ error: 'User and password are required' }, { status: 400 });
  }
  if (isPasscodeInUse(passcode.trim(), userId)) {
    return NextResponse.json({ error: 'Password is already in use' }, { status: 409 });
  }

  setUserPasscode(userId, passcode.trim());
  return NextResponse.json({ message: 'Password updated' });
}

export async function POST(req: NextRequest) {
  const user = getSessionUser(req);
  if (!user?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    const { name, passcode } = await req.json() as { name?: string; passcode?: string };
    const createdUser = createUser(name || '', passcode || '');
    return NextResponse.json({ user: createdUser }, { status: 201 });
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
    if (!userId || !getUserById(userId)) {
      return NextResponse.json({ error: 'User is required' }, { status: 400 });
    }

    deleteUser(userId);
    const files = readFiles().map(file => ({
      ...file,
      ratings: Object.fromEntries(
        Object.entries(file.ratings || {}).filter(([ratingUserId]) => ratingUserId !== userId)
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
