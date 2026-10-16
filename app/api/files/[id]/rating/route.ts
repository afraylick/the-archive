import { canEditRecording, archiveForRecording } from '@/lib/archives';
import { recordingAccess } from '@/lib/recording-access';
import { privateRatingAccess } from '@/lib/collections';
import { writeJsonAtomic } from '@/lib/json-storage';
import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser, getUserById, type UserId } from '@/lib/auth';
import fs from 'fs';
import { getDataFilePath } from '@/lib/storage';

interface AudioFileRecord {
  id: string;
  myRating?: number;
  userRating?: number;
  ratings?: Partial<Record<UserId, number>>;
  ratingUpdatedAt?: Partial<Record<UserId, string>>;
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const accessError = recordingAccess(req, (await params).id, 'read');
  if (accessError) return accessError;
  const { id } = await params;

  try {
    const user = getSessionUser(req);
    if (!user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const { rating, userId } = await req.json() as { rating?: number; userId?: UserId };
    const normalizedRating = Number.isFinite(rating) ? Math.max(0, Math.min(5, Math.round(rating || 0))) : 0;


    const dataFile = getDataFilePath();
    const data: AudioFileRecord[] = fs.existsSync(dataFile)
      ? JSON.parse(fs.readFileSync(dataFile, 'utf8'))
      : [];
    const index = data.findIndex(file => file.id === id);

    if (index === -1) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }
    const updatedFile = data[index];
    const ownerId = archiveForRecording(updatedFile)?.ownerId || 'adam';
    const ratingUserId = ownerId === 'adam' && canEditRecording(updatedFile, user) && user.isAdmin && userId && getUserById(userId) ? userId : user.id;
    updatedFile.ratings = updatedFile.ratings || {};
    updatedFile.ratingUpdatedAt = updatedFile.ratingUpdatedAt || {};
    updatedFile.ratings.adam = updatedFile.ratings.adam || updatedFile.myRating || 0;
    updatedFile.ratings[ratingUserId] = normalizedRating;
    updatedFile.ratingUpdatedAt[ratingUserId] = new Date().toISOString();
    updatedFile.myRating = updatedFile.ratings.adam || 0;
    updatedFile.userRating = ratingUserId === 'adam' ? 0 : normalizedRating;
    data[index] = updatedFile;

    writeJsonAtomic(dataFile, data);

    const showAllRatings = canEditRecording(updatedFile, user) || privateRatingAccess(req.nextUrl.searchParams.get('collection'), user, id);
    return NextResponse.json({
      ratings: showAllRatings
        ? updatedFile.ratings
        : {
            [ownerId]: updatedFile.ratings[ownerId] || 0,
            [user.id]: updatedFile.ratings[user.id] || 0,
          },
      myRating: updatedFile.ratings.adam || 0,
      userRating: updatedFile.ratings[user.id] || 0,
      ratingUpdatedAt: showAllRatings
        ? updatedFile.ratingUpdatedAt
        : {
            [ownerId]: updatedFile.ratingUpdatedAt[ownerId] || '',
            [user.id]: updatedFile.ratingUpdatedAt[user.id] || '',
          },
    });
  } catch {
    return NextResponse.json({ error: 'Rating update failed' }, { status: 500 });
  }
}
