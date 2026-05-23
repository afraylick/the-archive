import { createHmac, timingSafeEqual } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { NextRequest } from 'next/server';
import { getStorageRoot } from './storage';

export type UserId = string;

export interface ArchiveUser {
  id: UserId;
  name: string;
  isAdmin: boolean;
}

export const SESSION_COOKIE = 'archive_session';
const DEFAULT_DEV_SECRET = 'songie-local-dev-secret';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

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

const isProduction = () => process.env.NODE_ENV === 'production';

const getSecret = () => {
  const secret = process.env.ARCHIVE_AUTH_SECRET?.trim();
  if (secret) return secret;
  if (isProduction()) {
    throw new Error('ARCHIVE_AUTH_SECRET must be set in production.');
  }
  return DEFAULT_DEV_SECRET;
};
const getUsersFile = () => path.join(getStorageRoot(), 'users.json');
const getAccountsFile = () => path.join(getStorageRoot(), 'accounts.json');
const getLegacyUsersFile = () => path.join(process.cwd(), 'data/users.json');
const getLegacyAccountsFile = () => path.join(process.cwd(), 'data/accounts.json');

const readJsonFile = <T,>(filePath: string, fallback: T): T => {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
};

const timingSafeEqualText = (a: string, b: string) => {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  return aBuffer.length === bBuffer.length && timingSafeEqual(aBuffer, bBuffer);
};

const validatePasscode = (passcode: string) => {
  const cleanPasscode = passcode.trim();
  if (!cleanPasscode) throw new Error('Password is required');
  if (isProduction() && cleanPasscode.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  return cleanPasscode;
};

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
  const legacyUsers = readJsonFile<ArchiveUser[]>(getLegacyAccountsFile(), []);
  const storageUsers = readJsonFile<ArchiveUser[]>(getAccountsFile(), []);
  const usersById = new Map<string, ArchiveUser>();

  [...legacyUsers, ...storageUsers]
    .filter(user => user.id && user.name && user.id !== 'adam')
    .forEach(user => usersById.set(user.id, user));

  return Array.from(usersById.values());
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
    return timingSafeEqualText(storedHash, hashPasscode(passcode)) ||
      timingSafeEqualText(storedHash, hashPasscodeWithSecret(passcode, DEFAULT_DEV_SECRET));
  }

  const expectedCode = configuredCodes[user.id] || DEFAULT_CODES[user.id];
  if (isProduction() && !configuredCodes[user.id]) return false;
  return timingSafeEqualText(passcode, expectedCode);
};

export const hashPasscode = (passcode: string) => (
  hashPasscodeWithSecret(passcode, getSecret())
);

const hashPasscodeWithSecret = (passcode: string, secret: string) => (
  createHmac('sha256', secret).update(passcode).digest('base64url')
);

const readPasswordHashes = () => {
  const legacyHashes = readJsonFile<Partial<Record<UserId, string>>>(getLegacyUsersFile(), {});
  const storageHashes = readJsonFile<Partial<Record<UserId, string>>>(getUsersFile(), {});
  return { ...legacyHashes, ...storageHashes };
};

const getStoredPasswordHash = (userId: UserId) => readPasswordHashes()[userId];
const getPrimaryStoredPasswordHash = (userId: UserId) => (
  readJsonFile<Partial<Record<UserId, string>>>(getUsersFile(), {})[userId]
);

const writePasswordHashes = (hashes: Partial<Record<UserId, string>>) => {
  const usersFile = getUsersFile();
  const dir = path.dirname(usersFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(usersFile, JSON.stringify(hashes, null, 2));
};

const upgradeStoredPasscodeHash = (userId: UserId, passcode: string) => {
  const hashes = readPasswordHashes();
  hashes[userId] = hashPasscode(passcode);
  writePasswordHashes(hashes);
};

export const getUserByPasscode = (passcode: string) => {
  const user = getAllUsers().find(candidate => verifyPasscode(candidate.id, passcode));
  if (!user) return undefined;

  const storedHash = getStoredPasswordHash(user.id);
  const primaryHash = getPrimaryStoredPasswordHash(user.id);
  const currentHash = hashPasscode(passcode);
  const isLegacyDevHash = storedHash && timingSafeEqualText(storedHash, hashPasscodeWithSecret(passcode, DEFAULT_DEV_SECRET));
  if (storedHash && (!primaryHash || isLegacyDevHash || !timingSafeEqualText(storedHash, currentHash))) {
    upgradeStoredPasscodeHash(user.id, passcode);
  }

  return user;
};

export const isPasscodeInUse = (passcode: string, exceptUserId?: string) => (
  getAllUsers().some(user => user.id !== exceptUserId && verifyPasscode(user.id, passcode))
);

export const setUserPasscode = (userId: UserId, passcode: string) => {
  const cleanPasscode = validatePasscode(passcode);
  const hashes = readPasswordHashes();
  hashes[userId] = hashPasscode(cleanPasscode);
  writePasswordHashes(hashes);
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
  const cleanPasscode = validatePasscode(passcode);
  if (isPasscodeInUse(cleanPasscode)) throw new Error('Password is already in use');

  const user: ArchiveUser = {
    id: getUserIdFromName(cleanName),
    name: cleanName,
    isAdmin: false,
  };
  writeCustomUsers([...readCustomUsers(), user]);
  setUserPasscode(user.id, cleanPasscode);
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

const signSession = (userId: string, expiresAt: number) => (
  createHmac('sha256', getSecret()).update(`${userId}.${expiresAt}`).digest('base64url')
);

export const createSessionToken = (userId: UserId) => {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  return `v2.${userId}.${expiresAt}.${signSession(userId, expiresAt)}`;
};

export const getUserFromSessionToken = (token: string | undefined) => {
  if (!token) return null;

  const tokenParts = token.split('.');
  if (tokenParts[0] === 'v2') {
    const [, userId, expiresAtText, signature] = tokenParts;
    const expiresAt = Number(expiresAtText);
    const user = getUserById(userId);
    if (!user || !signature || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;

    const expectedSignature = signSession(user.id, expiresAt);
    return timingSafeEqualText(signature, expectedSignature) ? user : null;
  }

  const [userId, signature] = tokenParts;
  const user = getUserById(userId);
  if (!user || !signature) return null;

  const expectedSignature = signUserId(user.id);
  return timingSafeEqualText(signature, expectedSignature) ? user : null;
};

export const getSessionUser = (req: NextRequest) => (
  getUserFromSessionToken(req.cookies.get(SESSION_COOKIE)?.value)
);
