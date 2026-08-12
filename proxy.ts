import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE_NAME, verifySessionToken } from '@/lib/auth/session';

// Paths reachable without a dashboard session:
// - /login: the sign-in page itself
// - /api/auth/session: verifies the Google credential and issues the session cookie
// - /api/cron/scheduler: called by Vercel Cron / the external scheduler, authenticated by CRON_SECRET instead
const PUBLIC_PATHS = ['/login', '/api/auth/session', '/api/cron/scheduler'];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  const session = verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value);

  if (session) {
    return NextResponse.next();
  }

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const loginUrl = new URL('/login', request.url);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    // Everything except Next internals and static assets
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
