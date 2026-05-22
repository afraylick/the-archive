import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import fs from 'fs';
import { Readable } from 'stream';
import { ensureStorageDirs, getDataFilePath, getSafeDownloadName, getStemPath, isSafeStorageId } from '@/lib/storage';

interface StemAttachment {
  id: string;
  name: string;
  uploadedAt: string;
}

interface AudioFileRecord {
  id: string;
  stems?: StemAttachment;
  bobs?: boolean;
}

const MAX_STEMS_ZIP_BYTES = 2 * 1024 * 1024 * 1024;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const user = getSessionUser(req);
    if (!user?.isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const formData = await req.formData();
    const zipFile = formData.get('file') as File | null;
    if (!zipFile || !zipFile.name.toLowerCase().endsWith('.zip')) {
      return NextResponse.json({ error: 'A ZIP file is required' }, { status: 400 });
    }
    if (zipFile.size > MAX_STEMS_ZIP_BYTES) {
      return NextResponse.json({ error: 'ZIP file is too large' }, { status: 413 });
    }

    const dataFile = getDataFilePath();
    const data: AudioFileRecord[] = fs.existsSync(dataFile)
      ? JSON.parse(fs.readFileSync(dataFile, 'utf8'))
      : [];
    const index = data.findIndex(file => file.id === id);
    if (index === -1) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    ensureStorageDirs();

    if (data[index].stems?.id && isSafeStorageId(data[index].stems.id)) {
      const oldPath = getStemPath(data[index].stems.id);
      if (fs.existsSync(oldPath)) {
        fs.unlinkSync(oldPath);
      }
    }

    const stemId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}.zip`;
    fs.writeFileSync(getStemPath(stemId), Buffer.from(await zipFile.arrayBuffer()));

    const stems = {
      id: stemId,
      name: zipFile.name,
      uploadedAt: new Date().toISOString(),
    };
    data[index] = { ...data[index], stems };
    fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));

    return NextResponse.json({ stems });
  } catch {
    return NextResponse.json({ error: 'Stem upload failed' }, { status: 500 });
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
    const data: AudioFileRecord[] = fs.existsSync(dataFile)
      ? JSON.parse(fs.readFileSync(dataFile, 'utf8'))
      : [];
    const index = data.findIndex(file => file.id === id);
    if (index === -1) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    const stemId = data[index].stems?.id;
    if (stemId && isSafeStorageId(stemId)) {
      const stemPath = getStemPath(stemId);
      if (fs.existsSync(stemPath)) {
        fs.unlinkSync(stemPath);
      }
    }

    data[index] = { ...data[index], stems: undefined };
    fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));

    return NextResponse.json({ stems: null });
  } catch {
    return NextResponse.json({ error: 'Stem deletion failed' }, { status: 500 });
  }
}

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
    if (!file?.stems?.id || !isSafeStorageId(file.stems.id) || (user.id === 'bobs' && !file.bobs)) {
      return NextResponse.json({ error: 'Stems not found' }, { status: 404 });
    }

    const stemPath = getStemPath(file.stems.id);
    if (!fs.existsSync(stemPath)) {
      return NextResponse.json({ error: 'Stems file not found' }, { status: 404 });
    }

    const stat = fs.statSync(stemPath);
    const stream = Readable.toWeb(fs.createReadStream(stemPath));

    return new Response(stream as ReadableStream, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Length': String(stat.size),
        'Content-Disposition': `attachment; filename="${getSafeDownloadName(file.stems.name)}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch {
    return NextResponse.json({ error: 'Stem download failed' }, { status: 500 });
  }
}
