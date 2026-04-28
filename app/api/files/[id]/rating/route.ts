import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser, getUserById, type UserId } from '@/lib/auth';
import fs from 'fs';
import { getDataFilePath } from '@/lib/storage';

interface AudioFileRecord {
  id: string;
  myRating?: number;
  userRating?: number;
  ratings?: Partial<Record<UserId, number>>;
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const user = getSessionUser(req);
    if (!user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const { rating, userId } = await req.json() as { rating?: number; userId?: UserId };
    const normalizedRating = Number.isFinite(rating) ? Math.max(0, Math.min(5, Math.round(rating || 0))) : 0;
    const ratingUserId = user.isAdmin && userId && getUserById(userId) ? userId : user.id;

    const dataFile = getDataFilePath();
    const data: AudioFileRecord[] = fs.existsSync(dataFile)
      ? JSON.parse(fs.readFileSync(dataFile, 'utf8'))
      : [];
    const index = data.findIndex(file => file.id === id);

    if (index === -1) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    const updatedFile = data[index];
    updatedFile.ratings = updatedFile.ratings || {};
    updatedFile.ratings.adam = updatedFile.ratings.adam || updatedFile.myRating || 0;
    updatedFile.ratings[ratingUserId] = normalizedRating;
    updatedFile.myRating = updatedFile.ratings.adam || 0;
    updatedFile.userRating = ratingUserId === 'adam' ? 0 : normalizedRating;
    data[index] = updatedFile;

    fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));

    return NextResponse.json({
      ratings: user.isAdmin
        ? updatedFile.ratings
        : {
            adam: updatedFile.ratings.adam || 0,
            [user.id]: updatedFile.ratings[user.id] || 0,
          },
      myRating: updatedFile.ratings.adam || 0,
      userRating: updatedFile.ratings[user.id] || 0,
    });
  } catch {
    return NextResponse.json({ error: 'Rating update failed' }, { status: 500 });
  }
}
