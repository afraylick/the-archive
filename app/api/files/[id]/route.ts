import { trashRecording, TrashError } from '@/lib/trash';
import { recordingAccess } from '@/lib/recording-access';
import { archiveForRecording } from '@/lib/archives';
import { getCreatedAtWithYear } from '@/lib/recorded-date';
import { readArchive, writeJsonAtomic } from '@/lib/json-storage';
import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser, type UserId } from '@/lib/auth';
import { getDataFilePath } from '@/lib/storage';
import { isValidWaveformCache, WAVEFORM_PEAK_LENGTH } from '@/lib/waveform';

interface AudioFileRecord {
  id: string;
  projectId?: string;
  trashedAt?: string;
  defaultVersionId?: string;
  variationType?: 'linked';
  linkedAt?: string;
  linkedBy?: string;
  uploads?: unknown;
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
}

// Older clients must reload rather than replacing records from stale snapshots.
export async function PUT(req: NextRequest) {
  if (!getSessionUser(req)) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  return NextResponse.json({ error: 'Please reload the page before editing this recording' }, { status: 409 });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const user = getSessionUser(req);
    if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid mutation' }, { status: 400 });
    }
    const accessError = recordingAccess(req, id, body.operation === 'waveform' && body.waveform !== null ? 'read' : 'edit');
    if (accessError) return accessError;
    const data = readArchive<AudioFileRecord>();
    const index = data.findIndex(file => file.id === id);
    if (index < 0) return NextResponse.json({ error: 'File not found' }, { status: 404 });
    const current = data[index];
    const changes: Record<string, unknown> = {};
    const invalid = () => NextResponse.json({ error: 'Invalid mutation fields' }, { status: 400 });
    if (body.operation === 'metadata') {
      const input = body.changes;
      if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length) return invalid();
      for (const [key, value] of Object.entries(input)) {
        if (['name', 'originalName', 'notes', 'finish'].includes(key)) {
          const limit = key === 'notes' ? 10000 : key === 'finish' ? 80 : 255;
          if (typeof value !== 'string' || value.length > limit || (['name', 'originalName'].includes(key) && !value.trim())) return invalid();
          changes[key] = value;
        } else if (key === 'instruments' || key === 'vibes') {
          if (!Array.isArray(value) || value.length > 25 || value.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 80)) return invalid();
          changes[key] = Array.from(new Set(value.map(tag => tag.trim())));
          changes[key === 'instruments' ? 'instrument' : 'vibe'] = (changes[key] as string[])[0] || '';
        } else if (key === 'year') {
          if (typeof value !== 'number' || !Number.isInteger(value) || value < 1900 || value > 2100) return invalid();
          changes.year = value;
          changes.createdAt = getCreatedAtWithYear(current.createdAt, value);
        } else if (key === 'defaultVersionId') {
          if (current.projectId || typeof value !== 'string' || !(value === id || data.some(file => file.id === value && file.projectId === id && !file.trashedAt))) return invalid();
          changes.defaultVersionId = value;
        } else return invalid();
      }
      if ('name' in changes && !current.originalName && !('originalName' in changes)) changes.originalName = current.name;
    } else if (body.operation === 'waveform') {
      const waveform = body.waveform;
      if (waveform === null) {
        changes.waveformPeaks = null;
        changes.waveformDuration = null;
        changes.waveformCacheVersion = null;
      } else {
        if (!waveform || !isValidWaveformCache(waveform.waveformPeaks, waveform.waveformDuration, waveform.waveformCacheVersion) || waveform.waveformPeaks.length !== 1 || waveform.waveformPeaks[0].length > WAVEFORM_PEAK_LENGTH) return invalid();
        changes.waveformPeaks = waveform.waveformPeaks;
        changes.waveformDuration = waveform.waveformDuration;
        changes.waveformCacheVersion = waveform.waveformCacheVersion;
      }
    } else if (body.operation === 'reset-member-ratings') {
      const ownerId = archiveForRecording(current)?.ownerId || 'adam';
      const adminRating = current.ratings?.[ownerId] ?? (ownerId === 'adam' ? current.myRating ?? current.rating ?? 0 : 0);
      changes.ratings = { [ownerId]: adminRating };
      changes.myRating = adminRating;
      changes.userRating = 0;
      changes.ratingUpdatedAt = current.ratingUpdatedAt?.[ownerId] ? { [ownerId]: current.ratingUpdatedAt[ownerId] } : {};
    } else return invalid();
    data[index] = { ...current, ...changes };
    if (body.operation === 'waveform' && body.waveform === null) {
      delete data[index].waveformPeaks;
      delete data[index].waveformDuration;
      delete data[index].waveformCacheVersion;
    }
    writeJsonAtomic(getDataFilePath(), data);
    return NextResponse.json({ changes });
  } catch {
    return NextResponse.json({ error: 'Update failed' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getSessionUser(req);
  if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  try { return NextResponse.json(trashRecording((await params).id, user)); }
  catch (error) { return NextResponse.json({ error: error instanceof TrashError ? error.message : 'Move to trash failed' }, { status: error instanceof TrashError ? error.status : 500 }); }
}
