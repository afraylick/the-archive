import { NextRequest, NextResponse } from 'next/server';
import {
  createSessionToken,
  getUserByPasscode,
  getPublicUsers,
  getSessionUser,
  SESSION_COOKIE,
} from '@/lib/auth';
import { getArchiveSettings } from '@/lib/archive-settings';
import { clearFailedLogins, getLoginRateLimitStatus, recordFailedLogin } from '@/lib/login-rate-limit';

const isSecureRequest = (req: NextRequest) => (
  req.nextUrl.protocol === 'https:' ||
  req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() === 'https' ||
  process.env.NODE_ENV === 'production'
);

export async function GET(req: NextRequest) {
  const user = getSessionUser(req);
  return NextResponse.json({
    user,
    users: getPublicUsers(),
    settings: getArchiveSettings(),
  });
}

export async function POST(req: NextRequest) {
  try {
    const { passcode } = await req.json() as { passcode?: string };
    const limitStatus = getLoginRateLimitStatus(req, undefined);
    if (limitStatus.locked) {
      return NextResponse.json(
        { error: 'Too many login attempts. Try again later.' },
        {
          status: 429,
          headers: { 'Retry-After': String(limitStatus.retryAfterSeconds) },
        }
      );
    }

    // Reserve an attempt before asynchronous password work so parallel requests
    // cannot all pass the limit check before any failure is recorded.
    const failedStatus = recordFailedLogin(req, undefined);
    const loginUser = typeof passcode === 'string' && passcode.length <= 1024 ? await getUserByPasscode(passcode) : undefined;
    if (!passcode || !loginUser) {
      return NextResponse.json(
        { error: failedStatus.locked ? 'Too many login attempts. Try again later.' : 'Invalid login' },
        {
          status: failedStatus.locked ? 429 : 401,
          headers: failedStatus.locked ? { 'Retry-After': String(failedStatus.retryAfterSeconds) } : undefined,
        }
      );
    }

    clearFailedLogins(req, undefined);
    const response = NextResponse.json({
      user: getPublicUsers().find(user => user.id === loginUser.id),
    });
    response.cookies.set(SESSION_COOKIE, createSessionToken(loginUser.id), {
      httpOnly: true,
      sameSite: 'lax',
      secure: isSecureRequest(req),
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });
    return response;
  } catch {
    return NextResponse.json({ error: 'Login failed' }, { status: 500 });
  }
}

export async function DELETE() {
  const response = NextResponse.json({ message: 'Logged out' });
  response.cookies.set(SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return response;
}
