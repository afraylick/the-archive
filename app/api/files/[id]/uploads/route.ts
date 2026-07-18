import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getSessionUser, type UserId } from '@/lib/auth';
import { generateServerWaveform } from '@/lib/server-waveform';
import { ensureStorageDirs, getDataFilePath, getUploadsDir, isSafeStorageId } from '@/lib/storage';
import { WAVEFORM_CACHE_VERSION } from '@/lib/waveform';

interface AudioComment {
  id: string;
  text: string;
  timestamp?: number;
  userId: string;
  userName: string;
  createdAt: string;
}

interface AudioFileRecord {
  id: string;
  projectId?: string;
  name?: string;
  originalName?: string;
  instrument?: string;
  vibe?: string;
  instruments?: string[];
  vibes?: string[];
  finish?: string;
  collections?: string[];
  colorTags?: string[];
  year?: number;
  createdAt?: string;
  uploadedAt?: string;
  uploadedBy?: string;
  uploadedByName?: string;
  ratings?: Partial<Record<UserId, number>>;
  ratingUpdatedAt?: Partial<Record<UserId, string>>;
  likedBy?: string[];
  bobs?: boolean;
  notes?: string;
  comments?: AudioComment[];
}

const MAX_UPLOAD_FILE_BYTES = 30 * 1024 * 1024;
const MAX_NOTES_LENGTH = 10000;
const AUDIO_EXTENSIONS = new Set(['.aac', '.aif', '.aiff', '.flac', '.m4a', '.mp3', '.ogg', '.wav']);

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;

  try {
    const user = getSessionUser(req);
    if (!user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }
    if (!isSafeStorageId(projectId)) {
      return NextResponse.json({ error: 'Invalid project id' }, { status: 400 });
    }

    const formData = await req.formData();
    const file = formData.get('file');
    const notesValue = formData.get('notes');
    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json({ error: 'Choose one audio file to upload' }, { status: 400 });
    }
    if (file.size > MAX_UPLOAD_FILE_BYTES) {
      return NextResponse.json({ error: 'Audio uploads are limited to 30 MB' }, { status: 413 });
    }

    const extension = path.extname(file.name).toLowerCase();
    if (!AUDIO_EXTENSIONS.has(extension)) {
      return NextResponse.json({ error: 'Unsupported audio file type' }, { status: 415 });
    }

    ensureStorageDirs();
    const dataFile = getDataFilePath();
    const data: AudioFileRecord[] = fs.existsSync(dataFile)
      ? JSON.parse(fs.readFileSync(dataFile, 'utf8'))
      : [];
    const project = data.find(item => item.id === projectId && !item.projectId);
    if (!project || (user.id === 'bobs' && !project.bobs)) {
      return NextResponse.json({ error: 'Song project not found' }, { status: 404 });
    }

    const now = new Date();
    const storageId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}${extension}`;
    const filePath = path.join(getUploadsDir(), storageId);
    const buffer = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(filePath, buffer);

    let generatedWaveform: Awaited<ReturnType<typeof generateServerWaveform>> | null = null;
    try {
      generatedWaveform = await generateServerWaveform(filePath);
    } catch (error) {
      console.error('Version waveform generation failed for', file.name, error);
    }

    const upload: AudioFileRecord & {
      myRating: number;
      userRating: number;
      waveformPeaks?: number[][];
      waveformDuration?: number;
      waveformCacheVersion?: number;
    } = {
      id: storageId,
      projectId,
      name: project.name || file.name,
      originalName: file.name.slice(0, 255),
      instrument: project.instrument || '',
      vibe: project.vibe || '',
      instruments: Array.isArray(project.instruments) ? project.instruments : [],
      vibes: Array.isArray(project.vibes) ? project.vibes : [],
      finish: project.finish || '',
      collections: Array.isArray(project.collections) ? project.collections : [],
      colorTags: Array.isArray(project.colorTags) ? project.colorTags : [],
      year: now.getFullYear(),
      createdAt: now.toISOString(),
      uploadedAt: now.toISOString(),
      uploadedBy: user.id,
      uploadedByName: user.name,
      ratings: {},
      ratingUpdatedAt: {},
      myRating: 0,
      userRating: 0,
      likedBy: [],
      bobs: Boolean(project.bobs),
      notes: typeof notesValue === 'string' ? notesValue.slice(0, MAX_NOTES_LENGTH) : '',
      comments: [],
      waveformPeaks: generatedWaveform?.waveformPeaks,
      waveformDuration: generatedWaveform?.waveformDuration,
      waveformCacheVersion: generatedWaveform ? WAVEFORM_CACHE_VERSION : undefined,
    };

    data.push(upload);
    fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));
    return NextResponse.json({ upload }, { status: 201 });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}
