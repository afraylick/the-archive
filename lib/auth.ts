import { createHmac, timingSafeEqual } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { NextRequest } from 'next/server';

export type UserId = string;

export interface ArchiveUser {
  id: UserId;
  name: string;
  isAdmin: boolean;
}

export const SESSION_COOKIE = 'archive_session';

export const ARCHIVE_USERS: ArchiveUser[] = [
  { id: 'adam', name: 'Adam', isAdmin: true },
  { id: 'maurer', name: 'Maurer', isAdmin: false },
  { id: 'wills', name: 'Wills', isAdmin: false },
  { id: 'jordi', name: 'Jordi', isAdmin: false },
  { id: 'roland', name: 'Roland', isAdmin: false },
  { id: 'bobs', name: 'Bobs', isAdmin: false },
];

const DEFAULT_CODES: Record<UserId, string> = {
  adam: 'adam',
  maurer: 'maurer',
  wills: 'wills',
  jordi: 'jordi',
  roland: 'roland',
  bobs: 'bobs',
};

const getSecret = () => process.env.ARCHIVE_AUTH_SECRET || 'songie-local-dev-secret';
const getUsersFile = () => path.join(process.cwd(), 'data/users.json');
const getAccountsFile = () => path.join(process.cwd(), 'data/accounts.json');

const parseConfiguredCodes = () => {
  if (!process.env.ARCHIVE_ACCOUNT_CODES) return {};

  try {
    return JSON.parse(process.env.ARCHIVE_ACCOUNT_CODES) as Partial<Record<UserId, string>>;
  } catch {
    return {};
  }
};

export const getUserById = (id: string | undefined) => (
  getAllUsers().find(user => user.id === id)
);

const readCustomUsers = () => {
  try {
    const accountsFile = getAccountsFile();
    if (!fs.existsSync(accountsFile)) return [];
    const users = JSON.parse(fs.readFileSync(accountsFile, 'utf8')) as ArchiveUser[];
    return users.filter(user => user.id && user.name && user.id !== 'adam');
  } catch {
    return [];
  }
};

const writeCustomUsers = (users: ArchiveUser[]) => {
  const accountsFile = getAccountsFile();
  const dir = path.dirname(accountsFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(accountsFile, JSON.stringify(users, null, 2));
};

const getAllUsers = () => {
  const customUsers = readCustomUsers();
  const customIds = new Set(customUsers.map(user => user.id));
  return [
    ...ARCHIVE_USERS.filter(user => !customIds.has(user.id)),
    ...customUsers,
  ];
};

export const getPublicUsers = () => getAllUsers().map(user => ({
  id: user.id,
  name: user.name,
  isAdmin: user.isAdmin,
}));

export const verifyPasscode = (userId: string, passcode: string) => {
  const user = getUserById(userId);
  if (!user) return false;

  const configuredCodes = parseConfiguredCodes();
  const storedHash = getStoredPasswordHash(user.id);
  if (storedHash) {
    return storedHash === hashPasscode(passcode);
  }

  const expectedCode = configuredCodes[user.id] || DEFAULT_CODES[user.id];
  return passcode === expectedCode;
};

export const hashPasscode = (passcode: string) => (
  createHmac('sha256', getSecret()).update(passcode).digest('base64url')
);

const readPasswordHashes = () => {
  try {
    const usersFile = getUsersFile();
    if (!fs.existsSync(usersFile)) return {};
    return JSON.parse(fs.readFileSync(usersFile, 'utf8')) as Partial<Record<UserId, string>>;
  } catch {
    return {};
  }
};

const getStoredPasswordHash = (userId: UserId) => readPasswordHashes()[userId];

export const getUserByPasscode = (passcode: string) => (
  getAllUsers().find(user => verifyPasscode(user.id, passcode))
);

export const isPasscodeInUse = (passcode: string, exceptUserId?: string) => (
  getAllUsers().some(user => user.id !== exceptUserId && verifyPasscode(user.id, passcode))
);

export const setUserPasscode = (userId: UserId, passcode: string) => {
  const usersFile = getUsersFile();
  const dir = path.dirname(usersFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const hashes = readPasswordHashes();
  hashes[userId] = hashPasscode(passcode);
  fs.writeFileSync(usersFile, JSON.stringify(hashes, null, 2));
};

const getUserIdFromName = (name: string) => {
  const baseId = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'user';
  const existingIds = new Set(getAllUsers().map(user => user.id));
  let id = baseId;
  let suffix = 2;
  while (existingIds.has(id)) {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }
  return id;
};

export const createUser = (name: string, passcode: string) => {
  const cleanName = name.trim();
  if (!cleanName) throw new Error('User name is required');
  if (!passcode.trim()) throw new Error('Password is required');
  if (isPasscodeInUse(passcode.trim())) throw new Error('Password is already in use');

  const user: ArchiveUser = {
    id: getUserIdFromName(cleanName),
    name: cleanName,
    isAdmin: false,
  };
  writeCustomUsers([...readCustomUsers(), user]);
  setUserPasscode(user.id, passcode.trim());
  return user;
};

export const deleteUser = (userId: UserId) => {
  if (userId === 'adam') throw new Error('Adam cannot be deleted');

  const customUsers = readCustomUsers();
  const nextUsers = customUsers.filter(user => user.id !== userId);
  if (nextUsers.length === customUsers.length) throw new Error('User not found');
  writeCustomUsers(nextUsers);

  const usersFile = getUsersFile();
  const hashes = readPasswordHashes();
  delete hashes[userId];
  if (!fs.existsSync(path.dirname(usersFile))) {
    fs.mkdirSync(path.dirname(usersFile), { recursive: true });
  }
  fs.writeFileSync(usersFile, JSON.stringify(hashes, null, 2));
};

const signUserId = (userId: string) => (
  createHmac('sha256', getSecret()).update(userId).digest('base64url')
);

export const createSessionToken = (userId: UserId) => `${userId}.${signUserId(userId)}`;

export const getUserFromSessionToken = (token: string | undefined) => {
  if (!token) return null;

  const [userId, signature] = token.split('.');
  const user = getUserById(userId);
  if (!user || !signature) return null;

  const expectedSignature = signUserId(user.id);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (signatureBuffer.length !== expectedBuffer.length) return null;
  return timingSafeEqual(signatureBuffer, expectedBuffer) ? user : null;
};

export const getSessionUser = (req: NextRequest) => (
  getUserFromSessionToken(req.cookies.get(SESSION_COOKIE)?.value)
);
