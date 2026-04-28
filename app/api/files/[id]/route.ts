import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser, type UserId } from '@/lib/auth';
import fs from 'fs';
import { getDataFilePath, getStemPath, getUploadPath } from '@/lib/storage';

interface AudioFileRecord {
  id: string;
  instrument?: string;
  vibe?: string;
  instruments?: string[];
  vibes?: string[];
  finish?: string;
  collections?: string[];
  colorTags?: string[];
  waveformPeaks?: number[][];
  waveformDuration?: number;
  createdAt?: string;
  myRating?: number;
  userRating?: number;
  ratings?: Partial<Record<UserId, number>>;
  likedBy?: string[];
  bobs?: boolean;
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
    if (!user?.isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const updatedFile = await req.json() as AudioFileRecord;
    const dataFile = getDataFilePath();
    let data: AudioFileRecord[] = [];
    if (fs.existsSync(dataFile)) {
      data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    }
    const index = data.findIndex((f) => f.id === id);
    if (index === -1) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
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
    updatedFile.ratings = updatedFile.ratings || {};
    updatedFile.ratings.adam = updatedFile.ratings.adam || updatedFile.myRating || 0;
    updatedFile.myRating = updatedFile.ratings.adam || 0;
    data[index] = {
      ...updatedFile,
      likedBy: data[index].likedBy,
    };
    fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));
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
    const filePath = getUploadPath(id);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    if (data[index].stems?.id) {
      const stemPath = getStemPath(data[index].stems.id);
      if (fs.existsSync(stemPath)) {
        fs.unlinkSync(stemPath);
      }
    }
    data.splice(index, 1);
    fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));
    return NextResponse.json({ message: 'Deleted successfully' });
  } catch {
    return NextResponse.json({ error: 'Delete failed' }, { status: 500 });
  }
}
