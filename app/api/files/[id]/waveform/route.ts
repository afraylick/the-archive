import { recordingAccess } from '@/lib/recording-access';
import { getIndexedWaveform } from '@/lib/archive-index';
import { updateArchive } from '@/lib/json-storage';
import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { getDataFilePath, getUploadPath, isSafeStorageId } from '@/lib/storage';
import { generateServerWaveform } from '@/lib/server-waveform';
import { WAVEFORM_CACHE_VERSION } from '@/lib/waveform';
import fs from 'fs';

interface AudioFileRecord {
  id: string;
  waveformPeaks?: number[][];
  waveformDuration?: number;
  waveformCacheVersion?: number;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const accessError = recordingAccess(req, (await params).id, 'edit');
  if (accessError) return accessError;
  const { id } = await params;

  try {
    const user = getSessionUser(req);
    if (!user) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const dataFile = getDataFilePath();
    const data: AudioFileRecord[] = fs.existsSync(dataFile)
      ? JSON.parse(fs.readFileSync(dataFile, 'utf8'))
      : [];
    const index = data.findIndex(item => item.id === id);
    const file = data[index];
    if (!file || !isSafeStorageId(file.id)) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    const filePath = getUploadPath(id);
    if (!fs.existsSync(filePath)) {
      return NextResponse.json({ error: 'Audio file not found' }, { status: 404 });
    }

    const generated = await generateServerWaveform(filePath);
    const latestAccess = recordingAccess(req, id, 'edit');
    if (latestAccess) return latestAccess;
    let found = false;
    updateArchive<AudioFileRecord>(current => {
      const currentFile = current.find(item => item.id === id);
      if (!currentFile || !fs.existsSync(filePath)) return undefined;
      found = true;
      return current.map(item => item.id === id ? {
        ...item,
        waveformPeaks: generated.waveformPeaks,
        waveformDuration: generated.waveformDuration,
        waveformCacheVersion: WAVEFORM_CACHE_VERSION,
      } : item);
    });
    if (!found) {
      return NextResponse.json({ error: 'File was deleted during generation' }, { status: 404 });
    }

    return NextResponse.json({
      waveformPeaks: generated.waveformPeaks,
      waveformDuration: generated.waveformDuration,
      waveformCacheVersion: WAVEFORM_CACHE_VERSION,
      generator: generated.generator,
    });
  } catch (error) {
    console.error('Server waveform generation failed for', id, error);
    return NextResponse.json({ error: 'Waveform generation failed' }, { status: 500 });
  }
}


export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const accessError = recordingAccess(req, (await params).id, 'read');
  if (accessError) return accessError;
  if (!getSessionUser(req)) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  const { id } = await params;
  if (!isSafeStorageId(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  try {
    const waveform = getIndexedWaveform(id);
    if (!waveform) return NextResponse.json({ error: 'Recording not found' }, { status: 404 });
    return NextResponse.json(waveform, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch {
    return NextResponse.json({ error: 'Failed to load waveform' }, { status: 500 });
  }
}
