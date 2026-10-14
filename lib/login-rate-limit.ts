import { getStorageRoot } from './storage';
import { isIP } from 'net';
import { writeJsonAtomic } from '@/lib/json-storage';
import { createHmac } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { NextRequest } from 'next/server';

const MAX_FAILED_ATTEMPTS = 7;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;

interface LoginAttemptRecord {
  count: number;
  firstAttemptAt: number;
  lockedUntil?: number;
}

type LoginAttemptData = Record<string, LoginAttemptRecord>;

const getSecret = () => process.env.ARCHIVE_AUTH_SECRET || 'songie-local-dev-secret';
const getAttemptsFile = () => path.join(getStorageRoot(), 'login-attempts.json');

const getClientAddress = (req: NextRequest) => {
  // NextRequest does not provide a trustworthy socket address. Only opt into
  // a header when the network proxy overwrites it and direct origin access is blocked.
  const header = process.env.ARCHIVE_TRUSTED_IP_HEADER?.toLowerCase();
  if (!header) return 'shared';
  if (!['x-real-ip', 'cf-connecting-ip', 'x-forwarded-for'].includes(header)) throw new Error('Invalid trusted IP header');
  const address = req.headers.get(header)?.trim();
  return address && isIP(address) ? address.toLowerCase() : 'shared';
};

const getRateLimitKey = (req: NextRequest, userId: string | undefined) => {
  const account = userId?.trim().toLowerCase() || 'unknown';
  const clientHash = createHmac('sha256', getSecret())
    .update(getClientAddress(req))
    .digest('base64url');
  return `${account}:${clientHash}`;
};

const readAttempts = (): LoginAttemptData => {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(getAttemptsFile(), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error('Login limiter storage unavailable');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid login limiter storage');
  for (const record of Object.values(value)) {
    if (!record || !Number.isInteger(record.count) || record.count < 0 || !Number.isFinite(record.firstAttemptAt) || (record.lockedUntil !== undefined && !Number.isFinite(record.lockedUntil))) throw new Error('Invalid login limiter record');
  }
  return value as LoginAttemptData;
};

const writeAttempts = (attempts: LoginAttemptData) => {
  const attemptsFile = getAttemptsFile();
  const dir = path.dirname(attemptsFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  writeJsonAtomic(attemptsFile, attempts);
};

const pruneExpiredAttempts = (attempts: LoginAttemptData, now: number) => {
  for (const [key, record] of Object.entries(attempts)) {
    const lockExpired = !record.lockedUntil || record.lockedUntil <= now;
    const windowExpired = record.firstAttemptAt + ATTEMPT_WINDOW_MS <= now;
    if (lockExpired && windowExpired) {
      delete attempts[key];
    }
  }
};

export const getLoginRateLimitStatus = (req: NextRequest, userId: string | undefined) => {
  const now = Date.now();
  const attempts = readAttempts();
  pruneExpiredAttempts(attempts, now);
  const record = attempts[getRateLimitKey(req, userId)];
  writeAttempts(attempts);

  if (record?.lockedUntil && record.lockedUntil > now) {
    return {
      locked: true,
      retryAfterSeconds: Math.ceil((record.lockedUntil - now) / 1000),
    };
  }

  return { locked: false, retryAfterSeconds: 0 };
};

export const recordFailedLogin = (req: NextRequest, userId: string | undefined) => {
  const now = Date.now();
  const attempts = readAttempts();
  pruneExpiredAttempts(attempts, now);
  const key = getRateLimitKey(req, userId);
  const existing = attempts[key];
  if (!existing && Object.keys(attempts).length >= 10000) throw new Error('Login limiter capacity reached');
  const record = existing && existing.firstAttemptAt + ATTEMPT_WINDOW_MS > now
    ? existing
    : { count: 0, firstAttemptAt: now };

  record.count += 1;
  if (record.count >= MAX_FAILED_ATTEMPTS) {
    record.lockedUntil = now + LOCKOUT_MS;
  }

  attempts[key] = record;
  writeAttempts(attempts);

  return {
    locked: Boolean(record.lockedUntil && record.lockedUntil > now && record.count >= MAX_FAILED_ATTEMPTS),
    retryAfterSeconds: record.lockedUntil ? Math.ceil((record.lockedUntil - now) / 1000) : 0,
  };
};

export const clearFailedLogins = (req: NextRequest, userId: string | undefined) => {
  const attempts = readAttempts();
  delete attempts[getRateLimitKey(req, userId)];
  writeAttempts(attempts);
};
