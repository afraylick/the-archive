import fs from 'fs';
import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { getDataFilePath } from '@/lib/storage';

interface AudioFileRecord {
  id: string;
  collections?: string[];
  [key: string]: unknown;
}

const MAX_COLLECTION_NAME_LENGTH = 80;

const cleanCollectionName = (value: unknown) => (
  typeof value === 'string' ? value.trim().slice(0, MAX_COLLECTION_NAME_LENGTH) : ''
);

const readFiles = () => {
  const dataFile = getDataFilePath();
  const files: AudioFileRecord[] = fs.existsSync(dataFile)
    ? JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    : [];
  return { dataFile, files };
};

export async function PATCH(req: NextRequest) {
  try {
    const user = getSessionUser(req);
    if (!user?.isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const body = await req.json() as { collection?: unknown; name?: unknown };
    const collection = cleanCollectionName(body.collection);
    const name = cleanCollectionName(body.name);
    if (!collection || !name) {
      return NextResponse.json({ error: 'Both collection names are required' }, { status: 400 });
    }

    const { dataFile, files } = readFiles();
    let filesUpdated = 0;
    const nextFiles = files.map(file => {
      const collections = Array.isArray(file.collections) ? file.collections.filter(Boolean) : [];
      if (!collections.includes(collection)) return file;

      filesUpdated += 1;
      return {
        ...file,
        collections: Array.from(new Set(collections.map(value => value === collection ? name : value))),
      };
    });

    if (filesUpdated === 0) {
      return NextResponse.json({ error: 'Collection not found' }, { status: 404 });
    }

    fs.writeFileSync(dataFile, JSON.stringify(nextFiles, null, 2));
    return NextResponse.json({ collection: name, filesUpdated });
  } catch {
    return NextResponse.json({ error: 'Collection rename failed' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const user = getSessionUser(req);
    if (!user?.isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const body = await req.json() as { collection?: unknown };
    const collection = cleanCollectionName(body.collection);
    if (!collection) {
      return NextResponse.json({ error: 'Collection name is required' }, { status: 400 });
    }

    const { dataFile, files } = readFiles();
    let filesUpdated = 0;
    const nextFiles = files.map(file => {
      const collections = Array.isArray(file.collections) ? file.collections.filter(Boolean) : [];
      if (!collections.includes(collection)) return file;

      filesUpdated += 1;
      return { ...file, collections: collections.filter(value => value !== collection) };
    });

    if (filesUpdated === 0) {
      return NextResponse.json({ error: 'Collection not found' }, { status: 404 });
    }

    fs.writeFileSync(dataFile, JSON.stringify(nextFiles, null, 2));
    return NextResponse.json({ filesUpdated });
  } catch {
    return NextResponse.json({ error: 'Collection deletion failed' }, { status: 500 });
  }
}
