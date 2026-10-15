import { getArchiveIndex } from '@/lib/archive-index';
import { readAudioRange } from '@/lib/audio-range';
import { getMp3Container, streamMp3Container } from '@/lib/mp3-mp4';
import { NextRequest, NextResponse } from 'next/server';
import { runAudioJob, runFfmpeg } from '@/lib/audio-processing';
import { getSessionUser } from '@/lib/auth';
import { ensureDir, getAudioContentType, getSafeDownloadName, getTranscodedDir, getUploadPath, isSafeStorageId } from '@/lib/storage';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';

interface AudioFileRecord {
  id: string;
  name?: string;
  originalName?: string;
}

const AUDIO_CACHE_CONTROL = 'private, max-age=86400, stale-while-revalidate=604800';
const MOBILE_AUDIO_CACHE_CONTROL = 'private, max-age=604800, stale-while-revalidate=2592000';

const getContentDisposition = (downloadName: string | undefined): Record<string, string> => {
  if (!downloadName) return {};

  const safeName = getSafeDownloadName(downloadName);
  const fallbackName = safeName.replace(/[^\x20-\x7e]/g, '_');
  return {
    'Content-Disposition': `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
  };
};

const streamAudioFile = (
  filePath: string,
  contentType: string,
  rangeHeader: string | null,
  cacheControl = AUDIO_CACHE_CONTROL,
  downloadName?: string
) => {
  const stat = fs.statSync(filePath);
  const range = readAudioRange(rangeHeader, stat.size);

  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: {
      'Content-Range': `bytes */${stat.size}`, 'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store', 'Vary': 'Cookie',
    } });
  }
  if (range) {
    const stream = Readable.toWeb(fs.createReadStream(filePath, range));
    return new Response(stream as ReadableStream, {
      status: 206,
      headers: {
        'Accept-Ranges': 'bytes',
        'Cache-Control': cacheControl,
        'Content-Length': String(range.end - range.start + 1),
        'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
        'Content-Type': contentType,
        'Vary': 'Cookie',
        ...getContentDisposition(downloadName),
      },
    });
  }

  const stream = Readable.toWeb(fs.createReadStream(filePath));
  return new Response(stream as ReadableStream, {
    headers: {
      'Accept-Ranges': 'bytes',
      'Cache-Control': cacheControl,
      'Content-Length': String(stat.size),
      'Content-Type': contentType,
      'Vary': 'Cookie',
      ...getContentDisposition(downloadName),
    },
  });
};

const transcodeToMp3 = async (sourcePath: string, outputPath: string) => {
  ensureDir(path.dirname(outputPath));
  const tempPath = `${outputPath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;

  try {
    await runAudioJob(() => runFfmpeg([
      '-y', '-protocol_whitelist', 'file,pipe', '-i', /* turbopackIgnore: true */ sourcePath,
      '-vn', '-map_metadata', '-1', '-codec:a', 'libmp3lame', '-threads', '1', '-b:a', '192k',
      '-f', 'mp3', /* turbopackIgnore: true */ tempPath,
    ]));

    fs.renameSync(tempPath, outputPath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
};

const transcodes = (globalThis as typeof globalThis & { archiveTranscodes?: Map<string, Promise<void>> });
transcodes.archiveTranscodes ??= new Map();
const getMobileAudioPath = async (sourcePath: string, id: string) => {
  if (path.extname(id).toLowerCase() !== '.wav') return null;

  const sourceStat = fs.statSync(sourcePath);
  const outputPath = path.join(getTranscodedDir(), `${id}.mp3`);
  const outputStat = fs.existsSync(outputPath) ? fs.statSync(outputPath) : null;

  if (!outputStat || outputStat.mtimeMs < sourceStat.mtimeMs || outputStat.size === 0) {
    let pending = transcodes.archiveTranscodes!.get(outputPath);
    if (!pending) {
      pending = transcodeToMp3(sourcePath, outputPath).finally(() => transcodes.archiveTranscodes!.delete(outputPath));
      transcodes.archiveTranscodes!.set(outputPath, pending);
    }
    await pending;
  }

  return outputPath;
};

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const user = getSessionUser(req);
    if (!user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const file = getArchiveIndex().byId.get(id) as AudioFileRecord | undefined;
    if (!file || !isSafeStorageId(file.id)) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    const filePath = getUploadPath(id);
    if (!fs.existsSync(filePath)) {
      return NextResponse.json({ error: 'Audio file not found' }, { status: 404 });
    }

    const contentType = getAudioContentType(id);
    const wantsMobileAudio = req.nextUrl.searchParams.get('format') === 'mobile';
    const downloadName = req.nextUrl.searchParams.get('download') === '1'
      ? file.originalName || file.name || id
      : undefined;

    if (!downloadName && req.nextUrl.searchParams.get('format') === 'mp4' && path.extname(id).toLowerCase() === '.mp3') {
      try {
        const container = await getMp3Container(filePath);
        if (container) return streamMp3Container(filePath, container, req.headers.get('range'));
      } catch (error) {
        console.error('MP3 sample indexing failed for', id, error);
      }
      // Unsupported MP3 structures and temporary indexing failures keep the
      // original streaming path available. Downloads always bypass this branch.
    }

    if (wantsMobileAudio && !downloadName) {
      try {
        const mobileAudioPath = await getMobileAudioPath(filePath, id);
        if (mobileAudioPath) {
          return streamAudioFile(mobileAudioPath, 'audio/mpeg', req.headers.get('range'), MOBILE_AUDIO_CACHE_CONTROL, downloadName);
        }
      } catch (error) {
        console.error('Mobile audio transcode failed for', id, error);
      }
    }

    return streamAudioFile(filePath, contentType, req.headers.get('range'), AUDIO_CACHE_CONTROL, downloadName);
  } catch {
    return NextResponse.json({ error: 'Audio stream failed' }, { status: 500 });
  }
}
