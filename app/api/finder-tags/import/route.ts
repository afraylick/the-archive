import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser, type UserId } from '@/lib/auth';
import fs from 'fs';
import path from 'path';
import { getDataFilePath } from '@/lib/storage';

interface AudioFileRecord {
  id: string;
  name?: string;
  originalName?: string;
  colorTags?: string[];
  ratings?: Partial<Record<UserId, number>>;
  ratingUpdatedAt?: Partial<Record<UserId, string>>;
  myRating?: number;
}

interface FinderTagEntry {
  name?: string;
  fileName?: string;
  path?: string;
  relativePath?: string;
  colorTags?: string[];
}

interface FinderTagImport {
  files?: FinderTagEntry[];
}

const FINDER_COLORS = new Set(['gray', 'green', 'purple', 'blue', 'yellow', 'red', 'orange']);

const normalizeName = (value: string | undefined) => (
  value ? path.basename(value).trim().toLowerCase() : ''
);

const normalizeColorTags = (tags: unknown) => {
  if (!Array.isArray(tags)) return [];

  return Array.from(new Set(tags
    .map(tag => String(tag).trim().toLowerCase())
    .filter(tag => FINDER_COLORS.has(tag))
  ));
};

const deriveRatingFromColorTags = (colorTags: string[], fallbackRating: number) => {
  const colors = new Set(colorTags);
  if (colorTags.length > 3) return 5;
  if (colors.has('yellow') && colors.has('green')) return 2;
  if (colors.has('blue') && colors.has('green')) return 4;
  if (colors.has('blue')) return 5;
  if (colors.has('green')) return 3;
  if (colorTags.length === 1 && colors.has('yellow')) return 2;
  return fallbackRating;
};

export async function POST(req: NextRequest) {
  try {
    const user = getSessionUser(req);
    if (!user?.isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const formData = await req.formData();
    const metadataFile = formData.get('file') as File | null;
    if (!metadataFile) {
      return NextResponse.json({ error: 'Metadata file is required' }, { status: 400 });
    }

    const metadata = JSON.parse(await metadataFile.text()) as FinderTagImport;
    if (!Array.isArray(metadata.files)) {
      return NextResponse.json({ error: 'Invalid Finder tag metadata file' }, { status: 400 });
    }

    const dataFile = getDataFilePath();
    const data: AudioFileRecord[] = fs.existsSync(dataFile)
      ? JSON.parse(fs.readFileSync(dataFile, 'utf8'))
      : [];

    const fileIndexesByName = new Map<string, number[]>();
    data.forEach((file, index) => {
      for (const name of [file.name, file.originalName]) {
        const normalized = normalizeName(name);
        if (!normalized) continue;
        fileIndexesByName.set(normalized, [...(fileIndexesByName.get(normalized) || []), index]);
      }
    });

    let matched = 0;
    let updated = 0;
    let ambiguous = 0;
    let skipped = 0;

    for (const entry of metadata.files) {
      const candidateNames = [
        entry.name,
        entry.fileName,
        entry.relativePath,
        entry.path,
      ].map(normalizeName).filter(Boolean);
      const uniqueCandidateNames = Array.from(new Set(candidateNames));
      const matchedIndexes = Array.from(new Set(uniqueCandidateNames.flatMap(name => fileIndexesByName.get(name) || [])));

      if (matchedIndexes.length === 0) {
        skipped += 1;
        continue;
      }
      if (matchedIndexes.length > 1) {
        ambiguous += 1;
        continue;
      }

      const index = matchedIndexes[0];
      const colorTags = normalizeColorTags(entry.colorTags);
      const ratings = data[index].ratings || {};
      const currentAdamRating = ratings.adam || data[index].myRating || 0;
      const nextAdamRating = currentAdamRating > 0
        ? currentAdamRating
        : deriveRatingFromColorTags(colorTags, 0);

      data[index] = {
        ...data[index],
        colorTags,
        ratings: {
          ...ratings,
          adam: nextAdamRating,
        },
        ratingUpdatedAt: nextAdamRating > 0 && currentAdamRating === 0
          ? {
              ...(data[index].ratingUpdatedAt || {}),
              adam: new Date().toISOString(),
            }
          : data[index].ratingUpdatedAt,
        myRating: nextAdamRating,
      };
      matched += 1;
      updated += 1;
    }

    fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));

    return NextResponse.json({
      message: 'Finder tags imported',
      matched,
      updated,
      ambiguous,
      skipped,
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: 'Finder tag import failed' }, { status: 500 });
  }
}
