import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser, type UserId } from '@/lib/auth';
import path from 'path';
import fs from 'fs';
import { getRecordedDateFromFilename } from '@/lib/recorded-date';
import { ensureStorageDirs, getDataFilePath, getUploadsDir } from '@/lib/storage';

interface UploadMetadata {
  instrument?: string;
  vibe?: string;
  instruments?: string[];
  vibes?: string[];
  finish?: string;
  colorTags?: string[];
  year?: number;
  createdAt?: string;
  rating?: number;
  notes?: string;
  bobs?: boolean;
}

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
  bobs?: boolean;
  stems?: {
    id: string;
    name: string;
    uploadedAt: string;
  };
  colorTags: string[];
  waveformPeaks?: number[][];
  waveformDuration?: number;
  year: number;
  createdAt: string;
  ratings: Partial<Record<UserId, number>>;
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

    const dataFile = getDataFilePath();
    const uploadsDir = getUploadsDir();
    ensureStorageDirs();

    let data: AudioFileRecord[] = [];
    if (fs.existsSync(dataFile)) {
      data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    }

    const results: { id: string; name: string }[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const metadata = JSON.parse(metadataStrings[i]) as UploadMetadata;

      // Generate unique filename
      const ext = path.extname(file.name);
      const filename = Date.now() + '-' + Math.random().toString(36).substr(2, 9) + '-' + i + ext;
      const filepath = path.join(uploadsDir, filename);

      // Save file
      const buffer = Buffer.from(await file.arrayBuffer());
      fs.writeFileSync(filepath, buffer);

      // Save metadata
      const instruments = Array.isArray(metadata.instruments)
        ? metadata.instruments.filter(Boolean)
        : metadata.instrument
          ? [metadata.instrument]
          : [];
      const vibes = Array.isArray(metadata.vibes)
        ? metadata.vibes.filter(Boolean)
        : metadata.vibe
          ? [metadata.vibe]
          : [];
      const filenameRecordedDate = getRecordedDateFromFilename(file.name);
      const createdAt = filenameRecordedDate?.createdAt || metadata.createdAt || new Date().toISOString();
      const year = filenameRecordedDate?.year || metadata.year || new Date(createdAt).getFullYear();
      const finish = metadata.finish || (filenameRecordedDate ? 'Tracked' : deriveFinishFromFilename(file.name));
      const newEntry = {
        id: filename,
        name: file.name,
        instrument: instruments[0] || '',
        vibe: vibes[0] || '',
        instruments,
        vibes,
        finish,
        collections: [],
        likedBy: [],
        bobs: Boolean(metadata.bobs),
        colorTags: Array.isArray(metadata.colorTags) ? metadata.colorTags.filter(Boolean) : [],
        year,
        createdAt,
        ratings: { adam: metadata.rating || 0 },
        myRating: metadata.rating || 0,
        userRating: 0,
        notes: typeof metadata.notes === 'string' ? metadata.notes : '',
        comments: [],
        uploadedAt: new Date().toISOString(),
      };
      data.push(newEntry);
      results.push({ id: filename, name: file.name });
    }

    fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));

    return NextResponse.json({ message: 'Files uploaded successfully', results });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}
