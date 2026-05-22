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
const getAttemptsFile = () => path.join(process.cwd(), 'data/login-attempts.json');

const getClientAddress = (req: NextRequest) => {
  const forwardedFor = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return (
    req.headers.get('cf-connecting-ip') ||
    req.headers.get('x-real-ip') ||
    forwardedFor ||
    'unknown'
  );
};

const getRateLimitKey = (req: NextRequest, userId: string | undefined) => {
  const account = userId?.trim().toLowerCase() || 'unknown';
  const clientHash = createHmac('sha256', getSecret())
    .update(getClientAddress(req))
    .digest('base64url');
  return `${account}:${clientHash}`;
};

const readAttempts = () => {
  try {
    const attemptsFile = getAttemptsFile();
    if (!fs.existsSync(attemptsFile)) return {};
    return JSON.parse(fs.readFileSync(attemptsFile, 'utf8')) as LoginAttemptData;
  } catch {
    return {};
  }
};

const writeAttempts = (attempts: LoginAttemptData) => {
  const attemptsFile = getAttemptsFile();
  const dir = path.dirname(attemptsFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(attemptsFile, JSON.stringify(attempts, null, 2));
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
