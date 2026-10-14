import { updateArchive } from '@/lib/json-storage';
import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser, type UserId } from '@/lib/auth';
import path from 'path';
import fs from 'fs';
import { getCreatedAtWithYear, getRecordedDateFromFilename } from '@/lib/recorded-date';
import { generateServerWaveform } from '@/lib/server-waveform';
import { ensureStorageDirs, getUploadsDir } from '@/lib/storage';
import { WAVEFORM_CACHE_VERSION } from '@/lib/waveform';

interface UploadMetadata {
  instrument?: string;
  vibe?: string;
  instruments?: string[];
  vibes?: string[];
  collections?: string[];
  finish?: string;
  colorTags?: string[];
  year?: number;
  createdAt?: string;
  rating?: number;
  notes?: string;
}

const MAX_UPLOAD_FILES = 200;
const MAX_UPLOAD_FILE_BYTES = 500 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_TAGS_PER_CATEGORY = 25;
const MAX_TAG_LENGTH = 80;
const MAX_NOTES_LENGTH = 10000;

interface AudioFileRecord {
  id: string;
  name: string;
  instrument: string;
  vibe: string;
  instruments: string[];
  vibes: string[];
  finish: string;
  collections: string[];
  likedBy: string[];
  stems?: {
    id: string;
    name: string;
    uploadedAt: string;
  };
  colorTags: string[];
  waveformPeaks?: number[][];
  waveformDuration?: number;
  waveformCacheVersion?: number;
  year: number;
  createdAt: string;
  ratings: Partial<Record<UserId, number>>;
  ratingUpdatedAt?: Partial<Record<UserId, string>>;
  myRating: number;
  userRating: number;
  notes: string;
  comments: {
    id: string;
    text: string;
    timestamp?: number;
    userId: string;
    userName: string;
    createdAt: string;
  }[];
  uploadedAt: string;
}

const deriveFinishFromFilename = (filename: string) => filename.toLowerCase().includes('ste-0') ? 'Recorder' : 'Voice Memo';
const cleanTagArray = (tags: unknown) => Array.isArray(tags)
  ? Array.from(new Set(tags
      .map(tag => String(tag).trim())
      .filter(Boolean)
      .slice(0, MAX_TAGS_PER_CATEGORY)
      .map(tag => tag.slice(0, MAX_TAG_LENGTH))
    ))
  : [];

export async function POST(req: NextRequest) {
  try {
    const user = getSessionUser(req);
    if (!user?.isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const formData = await req.formData();
    const files = formData.getAll('files') as File[];
    const metadataStrings = [];
    for (const [key, value] of formData.entries()) {
      if (key.startsWith('metadata[')) {
        metadataStrings.push(value as string);
      }
    }

    if (files.length === 0) {
      return NextResponse.json({ error: 'No files uploaded' }, { status: 400 });
    }
    if (files.length > MAX_UPLOAD_FILES) {
      return NextResponse.json({ error: `Upload is limited to ${MAX_UPLOAD_FILES} files at a time` }, { status: 413 });
    }
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);
    if (files.some(file => file.size > MAX_UPLOAD_FILE_BYTES) || totalSize > MAX_UPLOAD_TOTAL_BYTES) {
      return NextResponse.json({ error: 'Upload is too large' }, { status: 413 });
    }

    const uploadsDir = getUploadsDir();
    ensureStorageDirs();

    const additions: AudioFileRecord[] = [];

    const results: { id: string; name: string }[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const metadata = metadataStrings[i] ? JSON.parse(metadataStrings[i]) as UploadMetadata : {};

      // Generate unique filename
      const ext = path.extname(file.name);
      const filename = Date.now() + '-' + Math.random().toString(36).substr(2, 9) + '-' + i + ext;
      const filepath = path.join(uploadsDir, filename);

      // Save file
      const buffer = Buffer.from(await file.arrayBuffer());
      fs.writeFileSync(filepath, buffer);

      // Save metadata
      const instruments = Array.isArray(metadata.instruments)
        ? cleanTagArray(metadata.instruments)
        : metadata.instrument
          ? cleanTagArray([metadata.instrument])
          : [];
      const vibes = Array.isArray(metadata.vibes)
        ? cleanTagArray(metadata.vibes)
        : metadata.vibe
          ? cleanTagArray([metadata.vibe])
          : [];
      const collections = cleanTagArray(metadata.collections);
      const filenameRecordedDate = getRecordedDateFromFilename(file.name);
      const detectedCreatedAt = metadata.createdAt || filenameRecordedDate?.createdAt || new Date().toISOString();
      const detectedYear = new Date(detectedCreatedAt).getFullYear();
      const year = Number.isInteger(metadata.year) && metadata.year! >= 1900 && metadata.year! <= 2100
        ? metadata.year!
        : filenameRecordedDate?.year || detectedYear;
      const createdAt = getCreatedAtWithYear(detectedCreatedAt, year);
      const finish = metadata.finish || (filenameRecordedDate ? 'Tracked' : deriveFinishFromFilename(file.name));
      const adamRating = Number.isFinite(metadata.rating) ? Math.max(0, Math.min(5, Math.round(metadata.rating || 0))) : 0;
      let generatedWaveform: Awaited<ReturnType<typeof generateServerWaveform>> | null = null;
      try {
        generatedWaveform = await generateServerWaveform(filepath);
      } catch (error) {
        console.error('Uploaded waveform generation failed for', file.name, error);
      }
      const newEntry = {
        id: filename,
        name: file.name,
        instrument: instruments[0] || '',
        vibe: vibes[0] || '',
        instruments,
        vibes,
        finish,
        collections,
        likedBy: [],
        colorTags: cleanTagArray(metadata.colorTags).slice(0, 10),
        waveformPeaks: generatedWaveform?.waveformPeaks,
        waveformDuration: generatedWaveform?.waveformDuration,
        waveformCacheVersion: generatedWaveform ? WAVEFORM_CACHE_VERSION : undefined,
        year,
        createdAt,
        ratings: { adam: adamRating },
        ratingUpdatedAt: adamRating > 0 ? { adam: new Date().toISOString() } : {},
        myRating: adamRating,
        userRating: 0,
        notes: typeof metadata.notes === 'string' ? metadata.notes.slice(0, MAX_NOTES_LENGTH) : '',
        comments: [],
        uploadedAt: new Date().toISOString(),
      };
      additions.push(newEntry);
      results.push({ id: filename, name: file.name });
    }

    updateArchive<AudioFileRecord>(current => [...current, ...additions]);

    return NextResponse.json({ message: 'Files uploaded successfully', results });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}
