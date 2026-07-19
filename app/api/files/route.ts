import { NextResponse } from 'next/server';
import { getSessionUser, type UserId } from '@/lib/auth';
import fs from 'fs';
import type { NextRequest } from 'next/server';
import { getDataFilePath, getUploadPath, isSafeStorageId } from '@/lib/storage';

interface AudioFileRecord {
  id: string;
  projectId?: string;
  defaultVersionId?: string;
  uploadedBy?: string;
  uploadedByName?: string;
  interactionUserIds?: string[];
  name?: string;
  originalName?: string;
  instrument?: string;
  vibe?: string;
  instruments?: string[];
  vibes?: string[];
  finish?: string;
  collections?: string[];
  colorTags?: string[];
  waveformPeaks?: number[][];
  waveformDuration?: number;
  waveformCacheVersion?: number;
  year?: number;
  createdAt?: string;
  uploadedAt?: string;
  rating?: number;
  myRating?: number;
  userRating?: number;
  ratings?: Partial<Record<UserId, number>>;
  ratingUpdatedAt?: Partial<Record<UserId, string>>;
  likedBy?: string[];
  stems?: {
    id: string;
    name: string;
    uploadedAt: string;
  };
  notes?: string;
  comments?: {
    id?: string;
    text: string;
    timestamp?: number;
    userId?: string;
    userName?: string;
    createdAt?: string;
  }[];
}

const TAG_NORMALIZATIONS: Record<string, string> = {
  'electric guitar': 'E. Guitar',
  'e. guitar': 'E. Guitar',
  'acoustic guitar': 'Acoustic',
};

const normalizeTag = (tag: string) => TAG_NORMALIZATIONS[tag.toLowerCase()] || tag;

const getRating = (file: AudioFileRecord, userId: UserId) => file.ratings?.[userId] || 0;

const getInteractionUserIds = (versions: AudioFileRecord[]) => {
  const userIds = new Set<string>();

  versions.forEach(version => {
    Object.entries(version.ratings || {}).forEach(([userId, rating]) => {
      if ((rating || 0) > 0) userIds.add(userId);
    });
    (Array.isArray(version.likedBy) ? version.likedBy : []).forEach(userId => userIds.add(userId));
    (Array.isArray(version.comments) ? version.comments : []).forEach(comment => {
      if (comment.userId) userIds.add(comment.userId);
    });
    if (version.projectId && version.uploadedBy) {
      userIds.add(version.uploadedBy);
    }
  });

  return Array.from(userIds);
};

const getUploadedAtFromId = (id: string | undefined) => {
  const timestampText = id?.match(/^(\d{12,})-/)?.[1];
  if (!timestampText) return undefined;

  const timestamp = Number(timestampText);
  if (!Number.isFinite(timestamp)) return undefined;

  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

const sanitizeFileForUser = (file: AudioFileRecord, userId: UserId, isAdmin: boolean) => {
  const ratings = file.ratings || {};
  const ratingUpdatedAt = file.ratingUpdatedAt || {};
  const visibleRatings = isAdmin
    ? ratings
    : {
        adam: ratings.adam || file.myRating || 0,
        [userId]: getRating(file, userId),
      };
  const visibleRatingUpdatedAt = isAdmin
    ? ratingUpdatedAt
    : {
        adam: ratingUpdatedAt.adam || '',
        [userId]: ratingUpdatedAt[userId] || '',
      };

  return {
    ...file,
    liked: file.likedBy?.includes(userId) || false,
    likedBy: isAdmin ? (file.likedBy || []) : file.likedBy?.includes(userId) ? [userId] : [],
    ratings: visibleRatings,
    ratingUpdatedAt: visibleRatingUpdatedAt,
    myRating: ratings.adam || file.myRating || 0,
    userRating: getRating(file, userId),
  };
};

export async function GET(req: NextRequest) {
  try {
    const user = getSessionUser(req);
    if (!user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const dataFile = getDataFilePath();
    if (!fs.existsSync(dataFile)) {
      return NextResponse.json([]);
    }
    let data = JSON.parse(fs.readFileSync(dataFile, 'utf8')) as AudioFileRecord[];

    // Migrate old rating to myRating and userRating
    data = data.map((file) => {
      if (file.rating !== undefined && file.myRating === undefined) {
        file.myRating = file.rating;
        file.userRating = 0;
        delete file.rating;
      }
      if (!file.ratings) {
        file.ratings = {};
      }
      file.ratings.adam = file.ratings.adam || file.myRating || 0;
      if (!Array.isArray(file.instruments)) {
        file.instruments = file.instrument ? [file.instrument] : [];
      }
      if (!Array.isArray(file.vibes)) {
        file.vibes = file.vibe ? [file.vibe] : [];
      }
      file.instruments = Array.from(new Set(file.instruments.filter(Boolean).map(normalizeTag)));
      file.vibes = Array.from(new Set(file.vibes.filter(Boolean)));
      if (!Array.isArray(file.colorTags)) {
        file.colorTags = [];
      }
      if (!Array.isArray(file.collections)) {
        file.collections = [];
      }
      file.collections = Array.from(new Set(file.collections.filter(Boolean)));
      if (!Array.isArray(file.likedBy)) {
        file.likedBy = [];
      }
      file.likedBy = Array.from(new Set(file.likedBy.filter(Boolean)));
      if (file.notes === undefined) {
        file.notes = file.comments?.filter(comment => !comment.userId).map(comment => comment.text).join('\n') || '';
      }
      file.comments = Array.isArray(file.comments)
        ? file.comments.filter(comment => comment.userId && comment.text).map(comment => ({
            ...comment,
            id: comment.id || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
            userName: comment.userName || comment.userId || 'Unknown',
            createdAt: comment.createdAt || new Date().toISOString(),
          }))
        : [];
      if (!file.createdAt) {
        const fallbackYear = file.year || new Date(file.uploadedAt || Date.now()).getFullYear();
        file.createdAt = new Date(Date.UTC(fallbackYear, 0, 1)).toISOString();
      }
      if (!file.uploadedAt) {
        file.uploadedAt = getUploadedAtFromId(file.id) || file.createdAt || new Date().toISOString();
      }
      file.instrument = file.instruments[0] || '';
      file.vibe = file.vibes[0] || '';
      file.finish = file.finish || '';
      file.myRating = file.ratings.adam || 0;
      file.userRating = getRating(file, user.id);
      return file;
    }).filter((file) => isSafeStorageId(file.id) && fs.existsSync(getUploadPath(file.id)));

    // Save migrated data
    fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));

    const projects = data.filter(file => !file.projectId);
    return NextResponse.json(projects.map(project => {
      const uploads = data
        .filter(file => file.projectId === project.id)
        .sort((a, b) => new Date(b.uploadedAt || 0).getTime() - new Date(a.uploadedAt || 0).getTime());

      return {
        ...sanitizeFileForUser(project, user.id, user.isAdmin),
        interactionUserIds: user.isAdmin ? getInteractionUserIds([project, ...uploads]) : undefined,
        uploads: uploads.map(file => sanitizeFileForUser(file, user.id, user.isAdmin)),
      };
    }));
  } catch {
    return NextResponse.json({ error: 'Failed to load files' }, { status: 500 });
  }
}
