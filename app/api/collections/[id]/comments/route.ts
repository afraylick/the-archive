import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { readCollections, writeCollections, canAccessCollection } from '@/lib/collections';

type Context = { params: Promise<{ id: string }> };
export async function POST(req: NextRequest, context: Context) {
  const user = getSessionUser(req);
  if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  const { id } = await context.params;
  const body = await req.json();
  if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4000) return NextResponse.json({ error: 'Write a message of up to 4,000 characters' }, { status: 400 });
  const collections = readCollections();
  const collection = collections.find(item => item.id === id && canAccessCollection(item, user));
  if (!collection) return NextResponse.json({ error: 'Collection not found or unavailable' }, { status: 404 });
  collection.comments.push({ id: randomUUID(), text: body.text.trim(), userId: user.id, userName: user.name, createdAt: new Date().toISOString() });
  writeCollections(collections);
  return NextResponse.json({ comments: collection.comments });
}

export async function DELETE(req: NextRequest, context: Context) {
  const user = getSessionUser(req);
  if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  const { id } = await context.params;
  const { commentId } = await req.json();
  const collections = readCollections();
  const collection = collections.find(item => item.id === id && canAccessCollection(item, user));
  if (!collection) return NextResponse.json({ error: 'Collection not found or unavailable' }, { status: 404 });
  const comment = collection.comments.find(item => item.id === commentId);
  if (!comment) return NextResponse.json({ error: 'Message not found' }, { status: 404 });
  if (comment.userId !== user.id && collection.ownerId !== user.id) return NextResponse.json({ error: 'Only the author or collection owner can delete this message' }, { status: 403 });
  collection.comments = collection.comments.filter(item => item.id !== commentId);
  writeCollections(collections);
  return NextResponse.json({ comments: collection.comments });
}
