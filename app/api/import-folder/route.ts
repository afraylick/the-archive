import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser, type UserId } from '@/lib/auth';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getRecordedDateFromFilename } from '@/lib/recorded-date';
import { ensureStorageDirs, getDataFilePath, getUploadsDir } from '@/lib/storage';
import { Readable } from 'stream';

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

interface ImportFolderRequest {
  action?: 'scan' | 'import';
  folderPath?: string;
  instruments?: string[];
  vibes?: string[];
  rating?: number;
  bobs?: boolean;
  files?: {
    path: string;
    instruments?: string[];
    vibes?: string[];
    finish?: string;
    rating?: number;
    notes?: string;
    bobs?: boolean;
  }[];
}

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.aiff', '.aif']);
const AUDIO_MIME_BY_EXTENSION: Record<string, string> = {
  '.aac': 'audio/aac',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};
const FINDER_COLOR_BY_INDEX: Record<string, string> = {
  '1': 'gray',
  '2': 'green',
  '3': 'purple',
  '4': 'blue',
  '5': 'yellow',
  '6': 'red',
  '7': 'orange',
};
const FINDER_COLOR_NAMES = new Set(Object.values(FINDER_COLOR_BY_INDEX));

const isAudioFile = (filePath: string) => AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());

const getAudioFiles = (dir: string): string[] => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  return entries.flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return getAudioFiles(entryPath);
    if (entry.isFile() && isAudioFile(entryPath)) return [entryPath];
    return [];
  });
};

const parseFinderTagOutput = (rawOutput: string) => {
  if (!rawOutput || rawOutput.includes('(null)')) return [];

  const quotedTags = Array.from(rawOutput.matchAll(/"((?:\\"|[^"])*)"/g), match =>
    match[1].replace(/\\"/g, '"').replace(/\\n/g, '\n')
  );
  const tags = quotedTags.length > 0 ? quotedTags : rawOutput.split(',').map(tag => tag.trim());

  return Array.from(new Set(tags.flatMap((tag) => {
    const colorIndex = tag.match(/\n([1-7])$/)?.[1] || tag.match(/\b([1-7])\b/)?.[1];
    const indexedColor = colorIndex ? FINDER_COLOR_BY_INDEX[colorIndex] : undefined;
    if (indexedColor) return [indexedColor];

    const lowerTag = tag.toLowerCase();
    return Array.from(FINDER_COLOR_NAMES).filter(color => lowerTag.includes(color));
  })));
};

const readFinderColorTags = (filePath: string) => {
  try {
    const output = execFileSync('mdls', ['-raw', '-name', 'kMDItemUserTags', filePath], {
      encoding: 'utf8',
      timeout: 2000,
    });
    return parseFinderTagOutput(output);
  } catch {
    return [];
  }
};

const deriveRatingFromColorTags = (colorTags: string[], fallbackRating: number) => {
  const colors = new Set(colorTags);
  if (colorTags.length > 3) return 5;
  if (colors.has('yellow') && colors.has('green')) return 2;
  if (colors.has('blue') && colors.has('green')) return 5;
  if (colors.has('blue')) return 4;
  if (colors.has('green')) return 3;
  if (colorTags.length === 1 && colors.has('yellow')) return 2;
  return fallbackRating;
};

const deriveFinishFromFilename = (filePath: string) => (
  path.basename(filePath).toLowerCase().includes('ste-0') ? 'Recorder' : 'Voice Memo'
);

const getFileMetadata = (filePath: string, fallbackRating = 0) => {
  const stat = fs.statSync(filePath);
  const filenameRecordedDate = getRecordedDateFromFilename(path.basename(filePath));
  const createdAt = filenameRecordedDate?.createdAt || (stat.birthtimeMs > 0 ? stat.birthtime.toISOString() : stat.mtime.toISOString());
  const colorTags = readFinderColorTags(filePath);

  return {
    path: filePath,
    name: path.basename(filePath),
    year: filenameRecordedDate?.year || new Date(createdAt).getFullYear(),
    createdAt,
    colorTags,
    finish: filenameRecordedDate ? 'Tracked' : deriveFinishFromFilename(filePath),
    rating: deriveRatingFromColorTags(colorTags, fallbackRating),
  };
};

export async function GET(req: NextRequest) {
  try {
    const user = getSessionUser(req);
    if (!user?.isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const filePath = req.nextUrl.searchParams.get('path');
    if (!filePath) {
      return NextResponse.json({ error: 'File path is required' }, { status: 400 });
    }

    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile() || !isAudioFile(resolvedPath)) {
      return NextResponse.json({ error: 'Audio file not found' }, { status: 404 });
    }

    const stream = fs.createReadStream(resolvedPath);
    const webStream = Readable.toWeb(stream) as ReadableStream;
    return new Response(webStream, {
      headers: {
        'Content-Type': AUDIO_MIME_BY_EXTENSION[path.extname(resolvedPath).toLowerCase()] || 'application/octet-stream',
      },
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: 'Preview failed' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = getSessionUser(req);
    if (!user?.isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const { action = 'import', folderPath, files, instruments = [], vibes = [], rating = 0, bobs = false } = await req.json() as ImportFolderRequest;
    if (!folderPath) {
      return NextResponse.json({ error: 'Folder path is required' }, { status: 400 });
    }

    const sourceDir = path.resolve(folderPath);
    if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
      return NextResponse.json({ error: 'Folder not found' }, { status: 404 });
    }

    const audioFiles = getAudioFiles(sourceDir);
    if (audioFiles.length === 0) {
      return NextResponse.json({ error: 'No audio files found' }, { status: 400 });
    }

    if (action === 'scan') {
      return NextResponse.json({
        files: audioFiles.map(filePath => getFileMetadata(filePath, rating)),
      });
    }

    const dataFile = getDataFilePath();
    const uploadsDir = getUploadsDir();
    ensureStorageDirs();

    const data: AudioFileRecord[] = fs.existsSync(dataFile)
      ? JSON.parse(fs.readFileSync(dataFile, 'utf8'))
      : [];

    const results: { id: string; name: string; colorTags: string[] }[] = [];
    const cleanInstruments = instruments.filter(Boolean);
    const cleanVibes = vibes.filter(Boolean);
    const importFiles = files && files.length > 0
      ? files.filter(file => {
          const resolvedPath = path.resolve(file.path);
          return resolvedPath.startsWith(sourceDir + path.sep) || resolvedPath === sourceDir;
        })
      : audioFiles.map(filePath => ({ path: filePath, instruments: cleanInstruments, vibes: cleanVibes, finish: undefined, rating, notes: '', bobs }));

    importFiles.forEach((fileMetadata, index) => {
      const filePath = path.resolve(fileMetadata.path);
      if (!fs.existsSync(filePath) || !isAudioFile(filePath)) return;

      const ext = path.extname(filePath);
      const filename = Date.now() + '-' + Math.random().toString(36).slice(2, 11) + '-' + index + ext;
      const sourceMetadata = getFileMetadata(filePath, fileMetadata.rating ?? rating);
      const fileInstruments = Array.isArray(fileMetadata.instruments) ? fileMetadata.instruments.filter(Boolean) : cleanInstruments;
      const fileVibes = Array.isArray(fileMetadata.vibes) ? fileMetadata.vibes.filter(Boolean) : cleanVibes;
      const finish = fileMetadata.finish || sourceMetadata.finish;
      const adamRating = deriveRatingFromColorTags(sourceMetadata.colorTags, fileMetadata.rating ?? rating);

      fs.copyFileSync(filePath, path.join(uploadsDir, filename));

      data.push({
        id: filename,
        name: path.basename(filePath),
        instrument: fileInstruments[0] || '',
        vibe: fileVibes[0] || '',
        instruments: fileInstruments,
        vibes: fileVibes,
        finish,
        collections: [],
        likedBy: [],
        bobs: Boolean(fileMetadata.bobs ?? bobs),
        colorTags: sourceMetadata.colorTags,
        year: sourceMetadata.year,
        createdAt: sourceMetadata.createdAt,
        ratings: { adam: adamRating },
        myRating: adamRating,
        userRating: 0,
        notes: typeof fileMetadata.notes === 'string' ? fileMetadata.notes : '',
        comments: [],
        uploadedAt: new Date().toISOString(),
      });

      results.push({ id: filename, name: path.basename(filePath), colorTags: sourceMetadata.colorTags });
    });

    fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));

    return NextResponse.json({ message: 'Folder imported successfully', results });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: 'Folder import failed' }, { status: 500 });
  }
}
