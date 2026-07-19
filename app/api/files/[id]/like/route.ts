import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import fs from 'fs';
import { getDataFilePath } from '@/lib/storage';

interface AudioFileRecord {
  id: string;
  likedBy?: string[];
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const user = getSessionUser(req);
    if (!user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const { liked } = await req.json() as { liked?: boolean };
    const dataFile = getDataFilePath();
    const data: AudioFileRecord[] = fs.existsSync(dataFile)
      ? JSON.parse(fs.readFileSync(dataFile, 'utf8'))
      : [];
    const index = data.findIndex(file => file.id === id);

    if (index === -1) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }
    const likedBy = new Set(Array.isArray(data[index].likedBy) ? data[index].likedBy : []);
    if (liked) {
      likedBy.add(user.id);
    } else {
      likedBy.delete(user.id);
    }

    const nextLikedBy = Array.from(likedBy);
    data[index] = { ...data[index], likedBy: nextLikedBy };
    fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));

    return NextResponse.json({
      liked: nextLikedBy.includes(user.id),
      likedBy: nextLikedBy.includes(user.id) ? [user.id] : [],
    });
  } catch {
    return NextResponse.json({ error: 'Like update failed' }, { status: 500 });
  }
}
