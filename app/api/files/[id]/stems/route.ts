import { reserveUploadQuota, stemReplacementCredit } from '@/lib/upload-quota';
import { recordingAccess } from '@/lib/recording-access';
import { receiveUpload, UploadError } from '@/lib/stream-upload';
import { randomUUID } from 'crypto';
import { writeJsonAtomic } from '@/lib/json-storage';
import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import fs from 'fs';
import { Readable } from 'stream';
import { cleanupStorageFile, ensureStorageDirs, getDataFilePath, getSafeDownloadName, getStemPath, isSafeStorageId } from '@/lib/storage';

interface StemAttachment {
  id: string;
  name: string;
  uploadedAt: string;
}

interface AudioFileRecord {
  id: string;
  stems?: StemAttachment;
}

const MAX_STEMS_ZIP_BYTES = 2 * 1024 * 1024 * 1024;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const accessError = recordingAccess(req, (await params).id, 'edit');
  if (accessError) return accessError;
  const { id } = await params;

  let quota: ReturnType<typeof reserveUploadQuota> | undefined;
  let staged: Awaited<ReturnType<typeof receiveUpload>> | undefined;
  try {
    const user = getSessionUser(req);
    if (!user) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const replacement = stemReplacementCredit(id, user.id);
    quota = reserveUploadQuota(user.id, replacement);
    staged = await receiveUpload(req, { files: 1, fileBytes: MAX_STEMS_ZIP_BYTES, totalBytes: MAX_STEMS_ZIP_BYTES, fileField: 'file', onFileBytes: quota.addBytes });
    const zipFile = staged.files[0];
    if (!zipFile || !zipFile.name.toLowerCase().endsWith('.zip')) {
      return NextResponse.json({ error: 'A ZIP file is required' }, { status: 400 });
    }
    if (zipFile.size > MAX_STEMS_ZIP_BYTES) {
      return NextResponse.json({ error: 'ZIP file is too large' }, { status: 413 });
    }

    const latestAccess = recordingAccess(req, id, 'edit');
    if (latestAccess) return latestAccess;
    const dataFile = getDataFilePath();
    const data: AudioFileRecord[] = fs.existsSync(dataFile)
      ? JSON.parse(fs.readFileSync(dataFile, 'utf8'))
      : [];
    const index = data.findIndex(file => file.id === id);
    if (index === -1) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    if (data[index].stems?.id !== replacement.stemId) throw new UploadError('Attachment changed during upload. Retry.', 409);
    quota.assertCapacity();
    ensureStorageDirs();

    const previousStemId = data[index].stems?.id;

    const stemId = `${randomUUID()}.zip`;
    const newStemPath = getStemPath(stemId);
    try {
      fs.renameSync(zipFile.path, newStemPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') cleanupStorageFile(newStemPath);
      throw error;
    }

    const stems = {
      id: stemId,
      uploadedBy: user.id,
      name: zipFile.name,
      uploadedAt: new Date().toISOString(),
    };
    data[index] = { ...data[index], stems };
    try {
      writeJsonAtomic(dataFile, data);
    } catch (error) {
      cleanupStorageFile(newStemPath);
      throw error;
    }
    if (previousStemId && isSafeStorageId(previousStemId)) cleanupStorageFile(getStemPath(previousStemId));

    return NextResponse.json({ stems });
  } catch (error) {
    return NextResponse.json({ error: error instanceof UploadError ? error.message : 'Stem upload failed' }, { status: error instanceof UploadError ? error.status : 500 });
  } finally {
    staged?.cleanup();
    quota?.release();
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const accessError = recordingAccess(req, (await params).id, 'edit');
  if (accessError) return accessError;
  const { id } = await params;

  try {
    const user = getSessionUser(req);
    if (!user) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const latestAccess = recordingAccess(req, id, 'edit');
    if (latestAccess) return latestAccess;
    const dataFile = getDataFilePath();
    const data: AudioFileRecord[] = fs.existsSync(dataFile)
      ? JSON.parse(fs.readFileSync(dataFile, 'utf8'))
      : [];
    const index = data.findIndex(file => file.id === id);
    if (index === -1) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    const stemId = data[index].stems?.id;
    data[index] = { ...data[index], stems: undefined };
    writeJsonAtomic(dataFile, data);

    if (stemId && isSafeStorageId(stemId)) cleanupStorageFile(getStemPath(stemId));

    return NextResponse.json({ stems: null });
  } catch {
    return NextResponse.json({ error: 'Stem deletion failed' }, { status: 500 });
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const accessError = recordingAccess(req, (await params).id, 'read');
  if (accessError) return accessError;
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
    if (!file?.stems?.id || !isSafeStorageId(file.stems.id)) {
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
