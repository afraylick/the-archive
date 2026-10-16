import { NextResponse, type NextRequest } from 'next/server';
import { getUserFromSessionToken, SESSION_COOKIE } from './lib/auth';

const PUBLIC_PATHS = ['/login', '/api/session'];
const ADMIN_PATHS = ['/users', '/api/users'];
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "base-uri 'self'; object-src 'none'; frame-ancestors 'none'",
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
  'Referrer-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

const withSecurityHeaders = (response: NextResponse) => {
  for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(header, value);
  }
  return response;
};

const isPublicPath = (pathname: string) => (
  PUBLIC_PATHS.some(path => pathname === path || pathname.startsWith(`${path}/`))
);

const isAdminPath = (pathname: string) => (
  ADMIN_PATHS.some(path => pathname === path || pathname.startsWith(`${path}/`))
);

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname)) {
    return withSecurityHeaders(NextResponse.next());
  }

  const user = getUserFromSessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (!user) {
    if (pathname.startsWith('/api/')) {
      return withSecurityHeaders(NextResponse.json({ error: 'Authentication required' }, { status: 401 }));
    }

    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('next', `${pathname}${request.nextUrl.search}`);
    return withSecurityHeaders(NextResponse.redirect(loginUrl));
  }

  if (isAdminPath(pathname) && !user.isAdmin) {
    if (pathname.startsWith('/api/')) {
      return withSecurityHeaders(NextResponse.json({ error: 'Admin access required' }, { status: 403 }));
    }

    return withSecurityHeaders(NextResponse.redirect(new URL('/', request.url)));
  }

  return withSecurityHeaders(NextResponse.next());
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|api/upload$|api/files/[^/]+/(?:stems|uploads)$|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico)$).*)',
  ],
};
