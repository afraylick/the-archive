import fs from 'fs';
import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { getDataFilePath, isSafeStorageId } from '@/lib/storage';

interface AudioFileRecord {
  id: string;
  projectId?: string;
  defaultVersionId?: string;
  variationType?: 'linked';
  linkedAt?: string;
  linkedBy?: string;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: sourceId } = await params;

  try {
    const user = getSessionUser(req);
    if (!user?.isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }
    if (!isSafeStorageId(sourceId)) {
      return NextResponse.json({ error: 'Invalid source song id' }, { status: 400 });
    }

    const body = await req.json() as { targetProjectId?: unknown };
    const targetProjectId = typeof body.targetProjectId === 'string' ? body.targetProjectId : '';
    if (!isSafeStorageId(targetProjectId) || targetProjectId === sourceId) {
      return NextResponse.json({ error: 'Choose a different song' }, { status: 400 });
    }

    const dataFile = getDataFilePath();
    const data = fs.existsSync(dataFile)
      ? JSON.parse(fs.readFileSync(dataFile, 'utf8')) as AudioFileRecord[]
      : [];
    const source = data.find(record => record.id === sourceId);
    const target = data.find(record => record.id === targetProjectId);

    if (!source || source.projectId) {
      return NextResponse.json({ error: 'Source song not found' }, { status: 404 });
    }
    if (!target || target.projectId) {
      return NextResponse.json({ error: 'Destination song not found' }, { status: 404 });
    }

    const linkedAt = new Date().toISOString();
    const movedIds: string[] = [];
    const updatedData = data.map(record => {
      if (record.id === sourceId) {
        const sourceRecord = { ...record };
        delete sourceRecord.defaultVersionId;
        movedIds.push(record.id);
        return {
          ...sourceRecord,
          projectId: targetProjectId,
          variationType: 'linked' as const,
          linkedAt,
          linkedBy: user.id,
        };
      }

      if (record.projectId === sourceId) {
        movedIds.push(record.id);
        return {
          ...record,
          projectId: targetProjectId,
        };
      }

      return record;
    });

    fs.writeFileSync(dataFile, JSON.stringify(updatedData, null, 2));
    return NextResponse.json({ sourceId, targetProjectId, movedIds });
  } catch (error) {
    console.error('Failed to link song variation', error);
    return NextResponse.json({ error: 'Failed to link song' }, { status: 500 });
  }
}
