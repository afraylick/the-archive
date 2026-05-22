import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { getAudioContentType, getDataFilePath, getUploadPath, isSafeStorageId } from '@/lib/storage';
import fs from 'fs';
import { Readable } from 'stream';

interface AudioFileRecord {
  id: string;
  bobs?: boolean;
}

const readRange = (rangeHeader: string | null, fileSize: number) => {
  if (!rangeHeader) return null;

  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;

  const startText = match[1];
  const endText = match[2];
  const start = startText ? Number(startText) : Math.max(fileSize - Number(endText || 0), 0);
  const end = endText ? Number(endText) : fileSize - 1;

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= fileSize) {
    return null;
  }

  return { start, end: Math.min(end, fileSize - 1) };
};

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const user = getSessionUser(req);
    if (!user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const dataFile = getDataFilePath();
    const data: AudioFileRecord[] = fs.existsSync(dataFile)
      ? JSON.parse(fs.readFileSync(dataFile, 'utf8'))
      : [];
    const file = data.find(item => item.id === id);
    if (!file || !isSafeStorageId(file.id) || (user.id === 'bobs' && !file.bobs)) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    const filePath = getUploadPath(id);
    if (!fs.existsSync(filePath)) {
      return NextResponse.json({ error: 'Audio file not found' }, { status: 404 });
    }

    const stat = fs.statSync(filePath);
    const contentType = getAudioContentType(id);
    const range = readRange(req.headers.get('range'), stat.size);

    if (range) {
      const stream = Readable.toWeb(fs.createReadStream(filePath, range));
      return new Response(stream as ReadableStream, {
        status: 206,
        headers: {
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, no-store',
          'Content-Length': String(range.end - range.start + 1),
          'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
          'Content-Type': contentType,
        },
      });
    }

    const stream = Readable.toWeb(fs.createReadStream(filePath));
    return new Response(stream as ReadableStream, {
      headers: {
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, no-store',
        'Content-Length': String(stat.size),
        'Content-Type': contentType,
      },
    });
  } catch {
    return NextResponse.json({ error: 'Audio stream failed' }, { status: 500 });
  }
}
