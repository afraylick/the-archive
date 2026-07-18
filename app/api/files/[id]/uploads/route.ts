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
const AUDIO_MIME_TYPES = new Set([
  'application/octet-stream',
  'application/ogg',
  'audio/aac',
  'audio/aiff',
  'audio/flac',
  'audio/mp3',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/vnd.wave',
  'audio/wav',
  'audio/wave',
  'audio/x-aac',
  'audio/x-aiff',
  'audio/x-flac',
  'audio/x-m4a',
  'audio/x-wav',
]);

const hasAsciiAt = (buffer: Buffer, value: string, offset = 0) => (
  buffer.length >= offset + value.length && buffer.subarray(offset, offset + value.length).toString('ascii') === value
);

const containsAscii = (buffer: Buffer, value: string, maxBytes = buffer.length) => (
  buffer.subarray(0, Math.min(buffer.length, maxBytes)).indexOf(Buffer.from(value, 'ascii')) >= 0
);

const isSupportedAudioBuffer = (buffer: Buffer, extension: string) => {
  if (buffer.length < 4) return false;

  const hasFrameSync = buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
  const isMp3 = hasAsciiAt(buffer, 'ID3') || (hasFrameSync && (buffer[1] & 0x06) !== 0);
  const isAac = hasFrameSync && (buffer[1] & 0x06) === 0;
  const isWav = hasAsciiAt(buffer, 'RIFF') && hasAsciiAt(buffer, 'WAVE', 8);
  const isAiff = hasAsciiAt(buffer, 'FORM') && (hasAsciiAt(buffer, 'AIFF', 8) || hasAsciiAt(buffer, 'AIFC', 8));
  const isFlac = hasAsciiAt(buffer, 'fLaC');
  const isOggAudio = hasAsciiAt(buffer, 'OggS') && (
    containsAscii(buffer, 'OpusHead', 65536) || containsAscii(buffer, 'vorbis', 65536)
  );
  const isMp4Container = hasAsciiAt(buffer, 'ftyp', 4);
  const isM4a = isMp4Container && (
    containsAscii(buffer, 'M4A ', 65536)
    || containsAscii(buffer, 'mp4a')
    || containsAscii(buffer, 'alac')
  );

  if (extension === '.mp3') return isMp3;
  if (extension === '.wav') return isWav;
  if (extension === '.aif' || extension === '.aiff') return isAiff;
  if (extension === '.flac') return isFlac;
  if (extension === '.ogg') return isOggAudio;
  if (extension === '.m4a') return isM4a;
  if (extension === '.aac') return isAac || isM4a;
  return false;
};

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
      return NextResponse.json({ error: 'Use an MP3, WAV, M4A, AAC, FLAC, OGG, or AIFF audio file' }, { status: 415 });
    }
    const mimeType = file.type.toLowerCase().split(';', 1)[0];
    if (mimeType && !AUDIO_MIME_TYPES.has(mimeType)) {
      return NextResponse.json({ error: 'The selected file is not a supported audio type' }, { status: 415 });
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

    const buffer = Buffer.from(await file.arrayBuffer());
    if (!isSupportedAudioBuffer(buffer, extension)) {
      return NextResponse.json({ error: 'The selected file does not contain supported audio data' }, { status: 415 });
    }

    const now = new Date();
    const storageId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}${extension}`;
    const filePath = path.join(getUploadsDir(), storageId);
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
