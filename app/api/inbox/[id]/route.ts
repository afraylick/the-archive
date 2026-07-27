import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { readInboxMessages, writeInboxMessages } from '@/lib/inbox';

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const user = getSessionUser(req);
    if (!user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const inbox = readInboxMessages();
    const messageIndex = inbox.findIndex(message => (
      message.id === id && message.recipientUserId === user.id
    ));
    if (messageIndex === -1) {
      return NextResponse.json({ error: 'Inbox message not found' }, { status: 404 });
    }

    inbox[messageIndex] = {
      ...inbox[messageIndex],
      readAt: inbox[messageIndex].readAt || new Date().toISOString(),
    };
    writeInboxMessages(inbox);

    return NextResponse.json({ message: inbox[messageIndex] });
  } catch (error) {
    console.error('Failed to mark inbox message as read', error);
    return NextResponse.json({ error: 'Failed to update inbox' }, { status: 500 });
  }
}
