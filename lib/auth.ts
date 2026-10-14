import { getTaskLimiter } from './task-limiter';
import { writeJsonAtomic } from '@/lib/json-storage';
import { createHmac, timingSafeEqual, randomBytes, scrypt } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { NextRequest } from 'next/server';
import { getArchiveSettings } from './archive-settings';
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

const LEGACY_USERS: ArchiveUser[] = [
  { id: 'adam', name: 'Adam', isAdmin: true },
  { id: 'maurer', name: 'Maurer', isAdmin: false },
  { id: 'wills', name: 'Wills', isAdmin: false },
  { id: 'jordi', name: 'Jordi', isAdmin: false },
  { id: 'roland', name: 'Roland', isAdmin: false },
];

const CLEAN_USERS: ArchiveUser[] = [
  { id: 'adam', name: 'Admin', isAdmin: true },
];

const isProduction = () => process.env.NODE_ENV === 'production';

const getSecret = () => {
  const secret = process.env.ARCHIVE_AUTH_SECRET?.trim();
  if (secret) return secret;
  if (isProduction()) {
    throw new Error('ARCHIVE_AUTH_SECRET must be set in production.');
  }
  return DEFAULT_DEV_SECRET;
};
const getCredentialMarker = () => path.join(getStorageRoot(), 'credentials-initialized.json');
const getUsersFile = () => path.join(getStorageRoot(), 'users.json');
const getAccountsFile = () => path.join(getStorageRoot(), 'accounts.json');
const getLegacyUsersFile = () => path.join(process.cwd(), 'data/users.json');
const getLegacyAccountsFile = () => path.join(process.cwd(), 'data/accounts.json');

// Existing credential/account files must never silently become empty stores.
const readJsonFile = <T,>(filePath: string, fallback: T): T => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw new Error('Account storage is unreadable; restore it from backup');
  }
};

const authLimiter = () => getTaskLimiter('auth', 1, 16);
const validHash = (value: unknown): value is string => typeof value === 'string' && (
  /^[A-Za-z0-9_-]{43}$/.test(value) || /^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(value)
);
const derivePassword = (passcode: string, salt: string) => new Promise<Buffer>((resolve, reject) => {
  scrypt(passcode, Buffer.from(salt, 'hex'), 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
    if (error) reject(error);
    else resolve(key);
  });
});
export const hashPasscode = async (passcode: string) => {
  const salt = randomBytes(16).toString('hex');
  return `scrypt-v1$${salt}$${(await derivePassword(passcode, salt)).toString('hex')}`;
};
const hashPasscodeWithSecret = (passcode: string, secret: string) => (
  createHmac('sha256', secret).update(passcode).digest('base64url')
);
const matchesHash = async (stored: string, passcode: string) => {
  if (stored.startsWith('scrypt-v1$')) {
    const [, salt, key] = stored.split('$');
    return timingSafeEqual(Buffer.from(key, 'hex'), await derivePassword(passcode, salt));
  }
  return timingSafeEqualText(stored, hashPasscodeWithSecret(passcode, getSecret())) ||
    timingSafeEqualText(stored, hashPasscodeWithSecret(passcode, DEFAULT_DEV_SECRET));
};

const timingSafeEqualText = (a: string, b: string) => {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  return aBuffer.length === bBuffer.length && timingSafeEqual(aBuffer, bBuffer);
};

const validatePasscode = (passcode: string) => {
  if (typeof passcode !== 'string' || passcode.length > 1024) throw new Error('Invalid password');
  const cleanPasscode = passcode.trim();
  if (!cleanPasscode) throw new Error('Password is required');
  if (isProduction() && cleanPasscode.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  return cleanPasscode;
};

const parseConfiguredCodes = (): Partial<Record<UserId, string>> => {
  if (!process.env.ARCHIVE_ACCOUNT_CODES) return {};
  const codes = JSON.parse(process.env.ARCHIVE_ACCOUNT_CODES);
  if (!codes || typeof codes !== 'object' || Array.isArray(codes) || Object.values(codes).some(code => typeof code !== 'string' || !code || code.length > 1024)) throw new Error('Invalid account configuration');
  return codes;
};

export const getUserById = (id: string | undefined) => (
  getAllUsers().find(user => user.id === id)
);

const readCustomUsers = () => {
  const legacyUsers = readJsonFile<ArchiveUser[]>(getLegacyAccountsFile(), []);
  const storageUsers = readJsonFile<ArchiveUser[]>(getAccountsFile(), []);
  const usersById = new Map<string, ArchiveUser>();

  if (![legacyUsers, storageUsers].every(users => Array.isArray(users) && users.every(user => user && typeof user.id === 'string' && typeof user.name === 'string' && typeof user.isAdmin === 'boolean'))) throw new Error('Invalid account storage');

  [...legacyUsers, ...storageUsers]
    .filter(user => user.id && user.name)
    .forEach(user => usersById.set(user.id, user));

  return Array.from(usersById.values());
};

const writeCustomUsers = (users: ArchiveUser[]) => {
  const accountsFile = getAccountsFile();
  const dir = path.dirname(accountsFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  writeJsonAtomic(accountsFile, users);
};

const getAllUsers = () => {
  const builtInUsers = getArchiveSettings().legacyDefaults ? LEGACY_USERS : CLEAN_USERS;
  const customUsers = readCustomUsers().filter(user => user.id !== 'bobs');
  const customIds = new Set(customUsers.map(user => user.id));
  return [
    ...builtInUsers.filter(user => !customIds.has(user.id)),
    ...customUsers,
  ];
};

export const getPublicUsers = () => getAllUsers().map(user => ({
  id: user.id,
  name: user.name,
  isAdmin: user.isAdmin,
}));

const readPasswordHashes = () => {
  const read = (file: string) => {
    const value = readJsonFile<Partial<Record<UserId, string>>>(file, {});
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(hash => !validHash(hash))) throw new Error('Invalid password storage');
    return value;
  };
  const marker = readJsonFile<{ version?: number } | null>(getCredentialMarker(), null);
  const hasMarker = fs.existsSync(getCredentialMarker());
  if (hasMarker && (!marker || marker.version !== 1)) throw new Error('Invalid credential marker');
  if (hasMarker && !fs.existsSync(getUsersFile())) throw new Error('Password storage is missing; restore it from backup');
  const primary = read(getUsersFile());
  if (!hasMarker && fs.existsSync(getUsersFile())) writeJsonAtomic(getCredentialMarker(), { version: 1 });
  // Primary values override legacy hashes. Never fall back on an unreadable primary.
  return { ...read(getLegacyUsersFile()), ...primary };
};
const getStoredPasswordHash = (userId: UserId) => readPasswordHashes()[userId];
const writePasswordHashes = (hashes: Partial<Record<UserId, string>>) => {
  // Write the marker first: interrupted initialization must fail closed.
  if (!fs.existsSync(getCredentialMarker())) writeJsonAtomic(getCredentialMarker(), { version: 1 });
  writeJsonAtomic(getUsersFile(), hashes);
};

const configuredPasscode = (id: string, hashes: Partial<Record<UserId, string>>) => {
  if (hashes[id]) return undefined;
  // Explicit operator configuration supports installations that previously used codes.
  // Missing/corrupt files can never reactivate the publicly known admin password.
  return parseConfiguredCodes()[id];
};
const verify = async (id: string, passcode: string, hashes = readPasswordHashes()) => {
  if (typeof passcode !== 'string' || !passcode || passcode.length > 1024) return false;
  const stored = hashes[id];
  if (stored) return matchesHash(stored, passcode);
  const configured = configuredPasscode(id, hashes);
  return Boolean(configured && timingSafeEqualText(passcode, configured));
};
export const verifyPasscode = (userId: string, passcode: string) => authLimiter().run(async () => (
  Boolean(getUserById(userId)) && await verify(userId, passcode)
));

export const getUserByPasscode = (passcode: string) => authLimiter().run(async () => {
  if (typeof passcode !== 'string' || !passcode || passcode.length > 1024) return undefined;
  const hashes = readPasswordHashes();
  for (const user of getAllUsers()) {
    if (!await verify(user.id, passcode, hashes)) continue;
    const stored = hashes[user.id];
    if (!stored?.startsWith('scrypt-v1$')) {
      const upgraded = await hashPasscode(passcode);
      const latest = readPasswordHashes();
      if (latest[user.id] !== stored || !getUserById(user.id)) return undefined;
      latest[user.id] = upgraded;
      writePasswordHashes(latest);
    }
    if (!getUserById(user.id)) return undefined;
    if (stored?.startsWith('scrypt-v1$') && getStoredPasswordHash(user.id) !== stored) return undefined;
    return user;
  }
  return undefined;
});

const passcodeInUse = async (passcode: string, exceptUserId?: string) => {
  const hashes = readPasswordHashes();
  for (const user of getAllUsers()) {
    if (user.id !== exceptUserId && await verify(user.id, passcode, hashes)) return true;
  }
  return false;
};
export const isPasscodeInUse = (passcode: string, exceptUserId?: string) => authLimiter().run(() => passcodeInUse(passcode, exceptUserId));

export const setUserPasscode = (userId: UserId, passcode: string) => authLimiter().run(async () => {
  const cleanPasscode = validatePasscode(passcode);
  if (!getUserById(userId)) throw new Error('User not found');
  if (await passcodeInUse(cleanPasscode, userId)) throw new Error('Password is already in use');
  const hashed = await hashPasscode(cleanPasscode);
  if (!getUserById(userId)) throw new Error('User not found');
  const hashes = readPasswordHashes();
  hashes[userId] = hashed;
  writePasswordHashes(hashes);
});

const getUserIdFromName = (name: string) => {
  const baseId = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'user';
  const existingIds = new Set([...getAllUsers().map(user => user.id), 'bobs']);
  let id = baseId;
  let suffix = 2;
  while (existingIds.has(id)) {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }
  return id;
};

export const createUser = (name: string, passcode: string) => authLimiter().run(async () => {
  const cleanName = name.trim();
  if (!cleanName) throw new Error('User name is required');
  const cleanPasscode = validatePasscode(passcode);
  if (await passcodeInUse(cleanPasscode)) throw new Error('Password is already in use');
  const hashed = await hashPasscode(cleanPasscode);
  const user: ArchiveUser = { id: getUserIdFromName(cleanName), name: cleanName, isAdmin: false };
  const hashes = readPasswordHashes();
  hashes[user.id] = hashed;
  writePasswordHashes(hashes);
  writeCustomUsers([...readCustomUsers(), user]);
  return user;
});

export const renameUser = (userId: UserId, name: string) => {
  const cleanName = name.trim();
  if (!cleanName) throw new Error('User name is required');

  const users = getAllUsers();
  const user = users.find(candidate => candidate.id === userId);
  if (!user) throw new Error('User not found');
  if (users.some(candidate => candidate.id !== userId && candidate.name.toLowerCase() === cleanName.toLowerCase())) {
    throw new Error('User name is already in use');
  }

  const storedUsers = readCustomUsers();
  const renamedUser = { ...user, name: cleanName };
  const storedIndex = storedUsers.findIndex(candidate => candidate.id === userId);
  if (storedIndex >= 0) storedUsers[storedIndex] = renamedUser;
  else storedUsers.push(renamedUser);
  writeCustomUsers(storedUsers);
  return renamedUser;
};

export const deleteUser = (userId: UserId) => {
  if (userId === 'adam') throw new Error('The Admin account cannot be deleted');

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
  writeJsonAtomic(usersFile, hashes);
};

const signSession = (userId: string, expiresAt: number, hash: string) => (
  createHmac('sha256', getSecret()).update(JSON.stringify(['v3', userId, expiresAt, hash])).digest('base64url')
);

export const createSessionToken = (userId: UserId) => {
  const hash = getStoredPasswordHash(userId);
  if (!hash || !getUserById(userId)) throw new Error('Account has no stored credential');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  return `v3.${userId}.${expiresAt}.${signSession(userId, expiresAt, hash)}`;
};

export const getUserFromSessionToken = (token: string | undefined) => {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 4 || parts[0] !== 'v3') return null;
    const [, userId, expiry, signature] = parts;
    const expiresAt = Number(expiry);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + SESSION_TTL_MS) return null;
    const user = getUserById(userId);
    const hash = getStoredPasswordHash(userId);
    if (!user || !hash) return null;
    return timingSafeEqualText(signature, signSession(userId, expiresAt, hash)) ? user : null;
  } catch {
    return null; // Unreadable credentials invalidate sessions as well as logins.
  }
};

export const getSessionUser = (req: NextRequest) => (
  getUserFromSessionToken(req.cookies.get(SESSION_COOKIE)?.value)
);
