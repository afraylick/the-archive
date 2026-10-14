import { writeJsonAtomic } from '@/lib/json-storage';
import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser, type UserId } from '@/lib/auth';
import fs from 'fs';
import { getDataFilePath, getStemPath, getUploadPath, isSafeStorageId } from '@/lib/storage';
import { isValidWaveformCache } from '@/lib/waveform';

interface AudioFileRecord {
  id: string;
  projectId?: string;
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

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const user = getSessionUser(req);
    if (!user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const updatedFile = await req.json() as AudioFileRecord;
    delete updatedFile.uploads;
    const dataFile = getDataFilePath();
    let data: AudioFileRecord[] = [];
    if (fs.existsSync(dataFile)) {
      data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    }
    const index = data.findIndex((f) => f.id === id);
    if (index === -1) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }
    if (!user.isAdmin) {
      if (updatedFile.waveformPeaks || updatedFile.waveformDuration) {
        if (!isValidWaveformCache(updatedFile.waveformPeaks, updatedFile.waveformDuration, updatedFile.waveformCacheVersion)) {
          return NextResponse.json({ error: 'Invalid waveform cache' }, { status: 400 });
        }
        data[index] = {
          ...data[index],
          waveformPeaks: updatedFile.waveformPeaks,
          waveformDuration: updatedFile.waveformDuration,
          waveformCacheVersion: updatedFile.waveformCacheVersion,
        };
        writeJsonAtomic(dataFile, data);
        return NextResponse.json({ message: 'Waveform updated successfully' });
      }

      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    if (Array.isArray(updatedFile.instruments)) {
      updatedFile.instrument = updatedFile.instruments[0] || '';
    }
    if (Array.isArray(updatedFile.vibes)) {
      updatedFile.vibe = updatedFile.vibes[0] || '';
    }
    updatedFile.collections = Array.isArray(updatedFile.collections)
      ? Array.from(new Set(updatedFile.collections.filter(Boolean)))
      : [];
    if (updatedFile.year !== undefined && (!Number.isInteger(updatedFile.year) || updatedFile.year < 1900 || updatedFile.year > 2100)) {
      updatedFile.year = data[index].year;
      updatedFile.createdAt = data[index].createdAt;
    }
    updatedFile.ratings = updatedFile.ratings || {};
    updatedFile.ratings.adam = updatedFile.ratings.adam || updatedFile.myRating || 0;
    updatedFile.myRating = updatedFile.ratings.adam || 0;
    if (updatedFile.waveformPeaks || updatedFile.waveformDuration) {
      if (!isValidWaveformCache(updatedFile.waveformPeaks, updatedFile.waveformDuration, updatedFile.waveformCacheVersion)) {
        delete updatedFile.waveformPeaks;
        delete updatedFile.waveformDuration;
        delete updatedFile.waveformCacheVersion;
      }
    }
    if (!data[index].projectId) {
      if (updatedFile.defaultVersionId === undefined && data[index].defaultVersionId) {
        updatedFile.defaultVersionId = data[index].defaultVersionId;
      }
      const requestedDefaultId = updatedFile.defaultVersionId || id;
      const validDefault = requestedDefaultId === id || data.some(file => file.id === requestedDefaultId && file.projectId === id);
      updatedFile.defaultVersionId = validDefault ? requestedDefaultId : id;
    }
    data[index] = {
      ...updatedFile,
      likedBy: data[index].likedBy,
      ratingUpdatedAt: updatedFile.ratingUpdatedAt || data[index].ratingUpdatedAt,
    };
    writeJsonAtomic(dataFile, data);
    return NextResponse.json({ message: 'Updated successfully' });
  } catch {
    return NextResponse.json({ error: 'Update failed' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const user = getSessionUser(req);
    if (!user?.isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const dataFile = getDataFilePath();
    let data: AudioFileRecord[] = [];
    if (fs.existsSync(dataFile)) {
      data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    }
    const index = data.findIndex((f) => f.id === id);
    if (index === -1) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }
    if (!isSafeStorageId(id)) {
      return NextResponse.json({ error: 'Invalid file id' }, { status: 400 });
    }
    const recordToDelete = data[index];
    const recordsToDelete = data.filter(file => file.id === id || file.projectId === id);
    for (const record of recordsToDelete) {
      if (isSafeStorageId(record.id)) {
        const filePath = getUploadPath(record.id);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }
      if (record.stems?.id && isSafeStorageId(record.stems.id)) {
        const stemPath = getStemPath(record.stems.id);
        if (fs.existsSync(stemPath)) {
          fs.unlinkSync(stemPath);
        }
      }
    }
    const deletedIds = new Set(recordsToDelete.map(record => record.id));
    const remainingData = data
      .filter(record => !deletedIds.has(record.id))
      .map(record => recordToDelete.projectId === record.id && record.defaultVersionId === id
        ? { ...record, defaultVersionId: record.id }
        : record
      );
    writeJsonAtomic(dataFile, remainingData);
    return NextResponse.json({ message: 'Deleted successfully' });
  } catch {
    return NextResponse.json({ error: 'Delete failed' }, { status: 500 });
  }
}
