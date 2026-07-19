import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import fs from 'fs';
import { getDataFilePath } from '@/lib/storage';

interface AudioFileRecord {
  id: string;
  collections?: string[];
}

const MAX_COLLECTIONS_PER_FILE = 50;
const MAX_COLLECTION_NAME_LENGTH = 80;

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const user = getSessionUser(req);
    if (!user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const { collections } = await req.json() as { collections?: string[] };
    const nextCollections = Array.isArray(collections)
      ? Array.from(new Set(collections
          .map(collection => collection.trim().slice(0, MAX_COLLECTION_NAME_LENGTH))
          .filter(Boolean)
        )).slice(0, MAX_COLLECTIONS_PER_FILE)
      : [];

    const dataFile = getDataFilePath();
    const data: AudioFileRecord[] = fs.existsSync(dataFile)
      ? JSON.parse(fs.readFileSync(dataFile, 'utf8'))
      : [];
    const index = data.findIndex(file => file.id === id);

    if (index === -1) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }
    data[index] = { ...data[index], collections: nextCollections };
    fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));

    return NextResponse.json({ collections: nextCollections });
  } catch {
    return NextResponse.json({ error: 'Collection update failed' }, { status: 500 });
  }
}
