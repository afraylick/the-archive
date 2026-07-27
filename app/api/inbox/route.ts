import fs from 'fs';
import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser, getUserById } from '@/lib/auth';
import { readInboxMessages, writeInboxMessages, type InboxMessage } from '@/lib/inbox';
import { getDataFilePath, isSafeStorageId } from '@/lib/storage';

interface AudioFileRecord {
  id: string;
  projectId?: string;
  name?: string;
}

const MAX_INBOX_NOTE_LENGTH = 2000;

export async function GET(req: NextRequest) {
  const user = getSessionUser(req);
  if (!user) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  const inbox = readInboxMessages()
    .filter(message => message.recipientUserId === user.id)
    .sort((a, b) => {
      if (Boolean(a.readAt) !== Boolean(b.readAt)) return a.readAt ? 1 : -1;
      return new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime();
    });

  return NextResponse.json({ inbox });
}

export async function POST(req: NextRequest) {
  try {
    const user = getSessionUser(req);
    if (!user?.isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const body = await req.json() as {
      recipientUserId?: unknown;
      songId?: unknown;
      note?: unknown;
    };
    const recipientUserId = typeof body.recipientUserId === 'string' ? body.recipientUserId : '';
    const songId = typeof body.songId === 'string' ? body.songId : '';
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, MAX_INBOX_NOTE_LENGTH) : '';
    const recipient = getUserById(recipientUserId);

    if (!recipient || recipient.isAdmin) {
      return NextResponse.json({ error: 'Choose a user' }, { status: 400 });
    }
    if (!isSafeStorageId(songId)) {
      return NextResponse.json({ error: 'Invalid song id' }, { status: 400 });
    }

    const dataFile = getDataFilePath();
    const songs = fs.existsSync(dataFile)
      ? JSON.parse(fs.readFileSync(dataFile, 'utf8')) as AudioFileRecord[]
      : [];
    const song = songs.find(record => record.id === songId && !record.projectId);
    if (!song) {
      return NextResponse.json({ error: 'Song not found' }, { status: 404 });
    }

    const message: InboxMessage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      recipientUserId: recipient.id,
      songId: song.id,
      songName: song.name || 'Untitled song',
      note,
      senderUserId: user.id,
      senderName: user.name,
      sentAt: new Date().toISOString(),
    };
    const inbox = readInboxMessages();
    inbox.push(message);
    writeInboxMessages(inbox);

    return NextResponse.json({ message }, { status: 201 });
  } catch (error) {
    console.error('Failed to send song to inbox', error);
    return NextResponse.json({ error: 'Failed to send song' }, { status: 500 });
  }
}
