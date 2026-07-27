import fs from 'fs';
import path from 'path';
import { ensureStorageDirs, getStorageRoot } from './storage';

export interface InboxMessage {
  id: string;
  recipientUserId: string;
  songId: string;
  songName: string;
  note: string;
  senderUserId: string;
  senderName: string;
  sentAt: string;
  readAt?: string;
}

const getInboxFilePath = () => path.join(getStorageRoot(), 'inbox.json');

export const readInboxMessages = () => {
  const inboxFile = getInboxFilePath();
  if (!fs.existsSync(inboxFile)) return [];

  try {
    const messages = JSON.parse(fs.readFileSync(inboxFile, 'utf8')) as unknown;
    return Array.isArray(messages) ? messages as InboxMessage[] : [];
  } catch {
    return [];
  }
};

export const writeInboxMessages = (messages: InboxMessage[]) => {
  ensureStorageDirs();
  fs.writeFileSync(getInboxFilePath(), JSON.stringify(messages, null, 2));
};
