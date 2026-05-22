import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import fs from 'fs';
import { getDataFilePath } from '@/lib/storage';

interface AudioComment {
  id: string;
  text: string;
  timestamp?: number;
  userId: string;
  userName: string;
  createdAt: string;
}

interface AudioFileRecord {
  id: string;
  bobs?: boolean;
  comments?: AudioComment[];
}

const MAX_COMMENT_LENGTH = 4000;
const MAX_COMMENTS_PER_FILE = 1000;

const readData = (dataFile: string): AudioFileRecord[] => (
  fs.existsSync(dataFile) ? JSON.parse(fs.readFileSync(dataFile, 'utf8')) : []
);

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const user = getSessionUser(req);
    if (!user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const { text, timestamp } = await req.json() as { text?: string; timestamp?: number };
    const cleanText = text?.trim().slice(0, MAX_COMMENT_LENGTH);
    if (!cleanText) {
      return NextResponse.json({ error: 'Comment text is required' }, { status: 400 });
    }

    const dataFile = getDataFilePath();
    const data = readData(dataFile);
    const index = data.findIndex(file => file.id === id);
    if (index === -1) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }
    if (user.id === 'bobs' && !data[index].bobs) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    const comments = Array.isArray(data[index].comments)
      ? data[index].comments!.filter(comment => comment.userId && comment.text)
      : [];
    if (comments.length >= MAX_COMMENTS_PER_FILE) {
      return NextResponse.json({ error: 'Comment limit reached for this file' }, { status: 413 });
    }
    const nextComment: AudioComment = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      text: cleanText,
      timestamp: typeof timestamp === 'number' && timestamp >= 0 ? timestamp : undefined,
      userId: user.id,
      userName: user.name,
      createdAt: new Date().toISOString(),
    };

    data[index] = { ...data[index], comments: [...comments, nextComment] };
    fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));

    return NextResponse.json({ comments: data[index].comments });
  } catch {
    return NextResponse.json({ error: 'Comment update failed' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const user = getSessionUser(req);
    if (!user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const { commentId } = await req.json() as { commentId?: string };
    if (!commentId) {
      return NextResponse.json({ error: 'Comment id is required' }, { status: 400 });
    }

    const dataFile = getDataFilePath();
    const data = readData(dataFile);
    const index = data.findIndex(file => file.id === id);
    if (index === -1) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }
    if (user.id === 'bobs' && !data[index].bobs) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    const comments = Array.isArray(data[index].comments) ? data[index].comments! : [];
    const comment = comments.find(existingComment => existingComment.id === commentId);
    if (!comment || comment.userId !== user.id) {
      return NextResponse.json({ error: 'You can only delete your own comments' }, { status: 403 });
    }

    data[index] = {
      ...data[index],
      comments: comments.filter(existingComment => existingComment.id !== commentId),
    };
    fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));

    return NextResponse.json({ comments: data[index].comments });
  } catch {
    return NextResponse.json({ error: 'Comment delete failed' }, { status: 500 });
  }
}
